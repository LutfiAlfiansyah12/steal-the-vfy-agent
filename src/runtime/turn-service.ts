import { createHmac } from 'node:crypto';
import type { Config } from '../config.js';
import { publicInputsHash } from '../protocol/hash.js';
import { HOLD, type TurnEnvelope, type TurnResponse } from '../protocol/schema.js';
import { TurnFailure, withDeadline, throwIfAborted } from './deadline.js';
import type { Engine } from './engine.js';
import { log } from './log.js';
import { logTurnFailure } from './failure.js';
import { turnFingerprint, turnKey, type TurnStore } from './store.js';

export class TurnService {
  private readonly pending = new Map<string, { fingerprint: string; result: Promise<string> }>();
  private accepting = true;
  private storageHealthy = true;

  constructor(private readonly config: Config, private readonly store: TurnStore, private readonly engine?: Engine) {}
  get ready(): boolean { return this.accepting && this.storageHealthy && this.engine !== undefined; }
  stop(): void { this.accepting = false; }

  private response(envelope: TurnEnvelope): TurnResponse {
    const digest = createHmac('sha256', this.config.hmacSecret).update(`steal-the-vfy:v1:${turnKey(envelope)}`).digest('hex');
    // Stable per turn and agent; independent of nonce so retransmissions replay the same decision.
    const key = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    return {
      matchId: envelope.matchId,
      turn: envelope.turn,
      action: HOLD,
      policyProof: { circuitVersion: 'v1', publicInputsHash: publicInputsHash(envelope, HOLD) },
      agentTimestamp: new Date().toISOString(),
      idempotencyKey: key,
    };
  }

  private echoMatch(body: string, envelope: TurnEnvelope): string {
    const cached = JSON.parse(body) as { matchId?: unknown; turn?: unknown };
    if (typeof cached.matchId !== 'string' || cached.matchId.toLowerCase() !== envelope.matchId.toLowerCase() || cached.turn !== envelope.turn) throw new TurnFailure('STORAGE');
    if (cached.matchId === envelope.matchId) return body;
    // UUID casing does not affect the proof/hash, but the response must echo this request.
    return JSON.stringify({ ...cached, matchId: envelope.matchId });
  }

  handle(envelope: TurnEnvelope, receivedAt: number): Promise<string> {
    // An uncertain disk commit can still be completing; require operator recovery.
    if (!this.storageHealthy) return Promise.reject(new TurnFailure('STORAGE'));
    const key = turnKey(envelope);
    const fingerprint = turnFingerprint(envelope);
    const existing = this.pending.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) return Promise.reject(new TurnFailure('CONFLICT'));
      return existing.result.then((body) => this.echoMatch(body, envelope));
    }
    // A completed durable turn can still be replayed while admission is full.
    // An unfinished or absent record remains retryable overload, never a fake action.
    if (this.pending.size >= 64) return this.replayAtCapacity(envelope, receivedAt, key, fingerprint);
    const result = this.run(envelope, receivedAt, key, fingerprint).finally(() => { this.pending.delete(key); });
    this.pending.set(key, { fingerprint, result });
    return result;
  }

  private async replayAtCapacity(envelope: TurnEnvelope, receivedAt: number, key: string, fingerprint: string): Promise<string> {
    const end = Math.min(Date.parse(envelope.deadlineAt), receivedAt + this.config.maxTurnMs);
    if (end - 100 <= Date.now()) throw new TurnFailure('DEADLINE');
    try {
      const stored = await withDeadline((signal) => this.store.get(key).then((value) => {
        throwIfAborted(signal);
        return value;
      }), end - 100);
      if (!stored) throw new TurnFailure('OVERLOADED');
      if (stored.fingerprint !== fingerprint) throw new TurnFailure('CONFLICT');
      if (!stored.body) throw new TurnFailure('OVERLOADED');
      return this.echoMatch(stored.body, envelope);
    } catch (error) {
      if (error instanceof TurnFailure && ['CONFLICT', 'OVERLOADED', 'DEADLINE'].includes(error.code)) throw error;
      throw new TurnFailure('STORAGE');
    }
  }

  private async run(envelope: TurnEnvelope, receivedAt: number, key: string, fingerprint: string): Promise<string> {
    const fallback = JSON.stringify(this.response(envelope));
    const end = Math.min(Date.parse(envelope.deadlineAt), receivedAt + this.config.maxTurnMs);
    const workDeadline = end - this.config.responseReserveMs;
    process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), event: 'turn_budget',
      envelopeRemainingMs: Math.max(0, Date.parse(envelope.deadlineAt) - receivedAt),
      localLimitMs: this.config.maxTurnMs,
      workRemainingMs: Math.max(0, workDeadline - Date.now()),
    })}\n`);
    if (end - 100 <= Date.now()) throw new TurnFailure('DEADLINE');
    try {
      return await withDeadline(async (signal) => {
        const stored = await this.store.get(key);
        throwIfAborted(signal);
        if (stored && stored.fingerprint !== fingerprint) throw new TurnFailure('CONFLICT');
        if (stored?.body) return this.echoMatch(stored.body, envelope);
        // An unfinished reservation after restart is ambiguous: never resubmit its proof.
        const reserved = stored ? false : await this.store.reserve(key, fingerprint);
        throwIfAborted(signal);
        let body = fallback;
        if (reserved && this.ready && this.engine && (envelope.mode !== 'competition' || this.config.allowCompetition)) {
          try {
            const evidence = await withDeadline((proofSignal) => this.engine!.execute(envelope, proofSignal), workDeadline);
            throwIfAborted(signal);
            const response = this.response(envelope);
            response.action = evidence.action;
            response.policyProof = {
              circuitVersion: 'v1', publicInputsHash: evidence.hash, proofReference: evidence.proofReference,
              proof: evidence.bundle.proof, public_signals: evidence.bundle.publicSignals,
            };
            body = JSON.stringify(response);
          } catch (error) {
            logTurnFailure(error);
            log('turn_hold');
          }
        }
        throwIfAborted(signal);
        await this.store.finish(key, { fingerprint, body });
        throwIfAborted(signal);
        if (body !== fallback) log('turn_proven');
        return body;
      }, end - 100);
    } catch (error) {
      if (error instanceof TurnFailure && error.code === 'CONFLICT') throw error;
      // A filesystem write cannot be cancelled. It may complete after this deadline.
      // Do not emit a keyed HOLD that could contradict a later durable proof response.
      // Return a signed transport failure; no action/idempotency decision is claimed.
      this.storageHealthy = false;
      log('storage_failed');
      throw new TurnFailure('STORAGE');
    }
  }
}
