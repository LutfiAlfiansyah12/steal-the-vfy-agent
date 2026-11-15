import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { publicInputsHash } from '../src/protocol/hash.js';
import { HOLD, type TurnEnvelope } from '../src/protocol/schema.js';
import { TurnFailure } from '../src/runtime/deadline.js';
import { TurnService } from '../src/runtime/turn-service.js';
import { turnFingerprint, turnKey, type StoredTurn, type TurnStore } from '../src/runtime/store.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function envelope(): TurnEnvelope {
  return { protocolVersion: 'v1', eventId: 'steal-the-vfy', mode: 'practice', matchId: randomUUID(), turn: 1,
    issuedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    state: { selfBalance: '100', opponentBalance: '100', selfFortifiedUntilTurn: null, opponentFortifiedUntilTurn: null },
    strategyCommitment: { hash: `0x${'0'.repeat(64)}` }, resolverVersion: 'v1', nonce: 'public-regression-fixture' };
}
function configuration() { return loadConfig({ AGENT_GAMES_HMAC_SECRET: randomBytes(32).toString('hex') }); }

test('overload never fabricates an unrecorded turn decision and replays durable results', async () => {
  const gate = deferred();
  const pendingTurns = Array.from({ length: 64 }, () => envelope());
  const blockedKeys = new Set(pendingTurns.map(turnKey));
  const records = new Map<string, StoredTurn>();
  const completed = envelope();
  const replayBody = JSON.stringify({ matchId: completed.matchId, turn: completed.turn, action: HOLD });
  records.set(turnKey(completed), { fingerprint: turnFingerprint(completed), body: replayBody });
  const store: TurnStore = {
    get: async (key) => {
      // Only the admitted operations are held; completed-turn reads remain available.
      if (blockedKeys.has(key)) await gate.promise;
      return records.get(key);
    },
    reserve: async (key, fingerprint) => { records.set(key, { fingerprint }); return true; },
    finish: async (key, value) => { records.set(key, value); },
  };
  const service = new TurnService(configuration(), store);
  const pending = Promise.all(pendingTurns.map((turn) => service.handle(turn, Date.now())));
  const absent = envelope();
  try {
    assert.equal(await service.handle(completed, Date.now()), replayBody);
    await assert.rejects(service.handle(absent, Date.now()), (error: unknown) => error instanceof TurnFailure && error.code === 'OVERLOADED');
    await assert.rejects(service.handle({ ...completed, state: { ...completed.state, selfBalance: '99' } }, Date.now()),
      (error: unknown) => error instanceof TurnFailure && error.code === 'CONFLICT');
  } finally {
    gate.resolve();
    await pending;
  }
  assert.equal(records.size, 65);
  assert.equal(await service.handle(completed, Date.now()), replayBody);
});

test('uncertain disk completion returns no action and latches subsequent requests off', async () => {
  const finishEntered = deferred();
  const releaseFinish = deferred();
  let durable: StoredTurn | undefined;
  const store: TurnStore = {
    get: async () => durable,
    reserve: async (_key, fingerprint) => { durable = { fingerprint }; return true; },
    finish: async (_key, value) => { finishEntered.resolve(); await releaseFinish.promise; durable = value; },
  };
  // Serialization-only fake engine; no valid proof, policy, or private parameter fixture.
  const service = new TurnService({ ...configuration(), maxTurnMs: 450, responseReserveMs: 100 }, store, {
    execute: async (turn) => ({ action: HOLD, hash: publicInputsHash(turn, HOLD),
      bundle: { proof: { transportFixture: true }, publicSignals: [] }, proofReference: `0x${'a'.repeat(64)}` }),
  });
  const turn = envelope();
  const pending = service.handle(turn, Date.now());
  // Keep the event loop live: production has the HTTP server; unit fixture does not.
  const keepAlive = setTimeout(() => undefined, 1500);
  try {
    await finishEntered.promise;
    await assert.rejects(pending, (error: unknown) => error instanceof TurnFailure && error.code === 'STORAGE');
    assert.equal(service.ready, false);
    releaseFinish.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(durable?.body, 'the late write can complete, but no contradictory HOLD was returned');
    await assert.rejects(service.handle(turn, Date.now()), (error: unknown) => error instanceof TurnFailure && error.code === 'STORAGE');
  } finally { releaseFinish.resolve(); clearTimeout(keepAlive); }
});
