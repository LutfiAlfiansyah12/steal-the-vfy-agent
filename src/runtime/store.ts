import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { TurnFailure } from './deadline.js';
import type { TurnEnvelope } from '../protocol/schema.js';

export interface StoredTurn { fingerprint: string; body?: string }
export interface TurnStore {
  get(key: string): Promise<StoredTurn | undefined>;
  reserve(key: string, fingerprint: string): Promise<boolean>;
  finish(key: string, value: Required<StoredTurn>): Promise<void>;
}

export function turnKey(envelope: TurnEnvelope): string {
  return createHash('sha256').update(`${envelope.matchId.toLowerCase()}:${envelope.turn}`).digest('hex');
}

/** Includes decision-relevant fields; retransmissions may change nonce/timestamps.
 * UUID and commitment casing are canonicalized because the protocol hashes them as
 * integers; a retry may differ only in presentation while replaying the same turn.
 */
export function turnFingerprint(envelope: TurnEnvelope): string {
  return createHash('sha256').update(JSON.stringify([
    envelope.protocolVersion, envelope.eventId, envelope.mode,
    envelope.matchId.toLowerCase(), envelope.turn, envelope.state.selfBalance, envelope.state.opponentBalance,
    envelope.state.selfFortifiedUntilTurn, envelope.state.opponentFortifiedUntilTurn,
    envelope.strategyCommitment.hash.toLowerCase(), envelope.resolverVersion,
  ])).digest('hex');
}

export class FileTurnStore implements TurnStore {
  constructor(private readonly directory: string) {}

  private path(key: string): string {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new TurnFailure('STORAGE');
    return resolve(this.directory, `${key}.json`);
  }

  async initialize(): Promise<void> { await mkdir(this.directory, { recursive: true, mode: 0o700 }); }

  async get(key: string): Promise<StoredTurn | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path(key), 'utf8'));
      if (!value || typeof value !== 'object' || !('fingerprint' in value) || typeof value.fingerprint !== 'string') throw new TurnFailure('STORAGE');
      if ('body' in value && typeof value.body !== 'string') throw new TurnFailure('STORAGE');
      return value as StoredTurn;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new TurnFailure('STORAGE');
    }
  }

  async reserve(key: string, fingerprint: string): Promise<boolean> {
    let handle;
    try {
      handle = await open(this.path(key), 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ fingerprint }));
      await handle.sync();
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw new TurnFailure('STORAGE');
    } finally { await handle?.close(); }
  }

  async finish(key: string, value: Required<StoredTurn>): Promise<void> {
    const path = this.path(key);
    const temporary = `${path}.${process.pid}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, path);
    } catch {
      await unlink(temporary).catch(() => undefined);
      throw new TurnFailure('STORAGE');
    }
  }
}
