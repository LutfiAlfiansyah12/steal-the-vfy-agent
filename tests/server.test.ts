import { strict as assert } from 'node:assert';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../src/config.js';
import { createAgentServer } from '../src/server.js';
import { sign, SIGNATURE_HEADER, verifySignature } from '../src/protocol/hmac.js';
import { publicInputsHash } from '../src/protocol/hash.js';
import { HOLD, type TurnEnvelope } from '../src/protocol/schema.js';
import { FileTurnStore, turnFingerprint, turnKey } from '../src/runtime/store.js';
import { TurnService } from '../src/runtime/turn-service.js';
import type { Engine } from '../src/runtime/engine.js';

function envelope(): TurnEnvelope {
  return {
    protocolVersion: 'v1', eventId: 'steal-the-vfy', mode: 'practice', matchId: randomUUID(), turn: 1,
    issuedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    state: { selfBalance: '100', opponentBalance: '100', selfFortifiedUntilTurn: null, opponentFortifiedUntilTurn: null },
    strategyCommitment: { hash: `0x${'0'.repeat(64)}` }, resolverVersion: 'v1', nonce: 'public-test-nonce',
  };
}
async function setup(engine?: Engine) {
  const directory = await mkdtemp(join(tmpdir(), 'vfy-test-'));
  const secret = randomBytes(32).toString('hex');
  const config = loadConfig({ AGENT_GAMES_HMAC_SECRET: secret, DATA_DIRECTORY: directory, MAX_TURN_MS: '1000', RESPONSE_RESERVE_MS: '200' });
  const store = new FileTurnStore(directory);
  await store.initialize();
  const service = new TurnService(config, store, engine);
  const server = createAgentServer(config, service);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function post(body: string, signature = sign(body, secret), headers: Record<string, string> = {}) {
    const response = await fetch(`${origin}/agent`, { method: 'POST', headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signature, ...headers }, body });
    const raw = await response.text();
    assert(verifySignature(Buffer.from(raw), response.headers.get(SIGNATURE_HEADER) ?? undefined, secret), 'response signed over exact bytes');
    return { status: response.status, raw, body: JSON.parse(raw) as Record<string, any> };
  }
  return { config, store, service, post, origin, close: async () => {
    service.stop();
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    await rm(directory, { force: true, recursive: true });
  } };
}

test('HTTP verifies signature before JSON parsing and signs all error responses', async (t) => {
  const app = await setup(); t.after(app.close);
  assert.equal((await app.post('{invalid', '0'.repeat(64))).status, 401);
  assert.equal((await app.post('{invalid')).status, 400);
  assert.equal((await app.post('{}', undefined, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await app.post('x'.repeat(33 * 1024))).status, 413);
});

test('preflight is signed, timestamp checked, and separate from readiness', async (t) => {
  const app = await setup(); t.after(app.close);
  const preflight = { type: 'agent-games.preflight.v1', agent_id: 'agt_test', issued_at: new Date().toISOString(), nonce: 'public-nonce' };
  assert.deepEqual((await app.post(JSON.stringify(preflight))).body, { ok: true, protocolVersion: 'v1' });
  assert.equal((await app.post(JSON.stringify({ ...preflight, issued_at: new Date(Date.now() - 61_000).toISOString() }))).status, 400);
  assert.equal((await app.post(JSON.stringify({ ...preflight, issued_at: new Date(Date.now() + 60_000).toISOString() }))).status, 400);
  assert.equal((await fetch(`${app.origin}/healthz`)).status, 200);
  assert.equal((await fetch(`${app.origin}/readyz`)).status, 503);
});

test('unconfigured strategy returns signed HOLD without claiming a proof', async (t) => {
  const app = await setup(); t.after(app.close);
  const turn = envelope();
  const response = await app.post(JSON.stringify(turn));
  assert.equal(response.status, 200);
  assert.equal(response.body.matchId, turn.matchId);
  assert.equal(response.body.turn, turn.turn);
  assert.deepEqual(response.body.action, HOLD);
  assert.equal(response.body.policyProof.publicInputsHash, publicInputsHash(turn, HOLD));
  assert.equal(response.body.policyProof.circuitVersion, 'v1');
  assert.equal('proofReference' in response.body.policyProof, false);
  assert.equal('proof' in response.body, false);
  assert.equal('public_signals' in response.body, false);
});

test('same turn replays exact bytes across new nonce and service restart; keys differ across turns', async (t) => {
  const app = await setup(); t.after(app.close);
  const turn = envelope();
  const first = await app.post(JSON.stringify(turn));
  const retry = { ...turn, nonce: 'retry-nonce', issuedAt: new Date().toISOString() };
  assert.equal((await app.post(JSON.stringify(retry))).raw, first.raw);
  const restarted = new TurnService(app.config, app.store);
  assert.equal(await restarted.handle(retry, Date.now()), first.raw);
  const next = await app.post(JSON.stringify({ ...turn, turn: 2 }));
  assert.notEqual(next.body.idempotencyKey, first.body.idempotencyKey);
});

test('casing-only UUID retry preserves the decision and echoes the request exactly', async (t) => {
  const app = await setup(); t.after(app.close);
  const turn = { ...envelope(), matchId: 'aabbccdd-0011-4233-8455-aabbccddeeff' };
  const first = await app.post(JSON.stringify(turn));
  const retry = { ...turn, matchId: turn.matchId.toUpperCase() };
  const second = await app.post(JSON.stringify(retry));
  assert.equal(second.status, 200);
  assert.equal(second.body.matchId, retry.matchId);
  assert.equal(second.body.idempotencyKey, first.body.idempotencyKey);
  assert.deepEqual(second.body.action, first.body.action);
  assert.deepEqual(second.body.policyProof, first.body.policyProof);
});

test('same match and turn with different balances is a signed conflict', async (t) => {
  const app = await setup(); t.after(app.close);
  const turn = envelope();
  await app.post(JSON.stringify(turn));
  const conflict = { ...turn, state: { ...turn.state, selfBalance: '99' } };
  const response = await app.post(JSON.stringify(conflict));
  assert.equal(response.status, 409);
  assert.equal(response.body.error, 'TURN_CONFLICT');
});

test('expired envelope fails closed without running proof engine', async (t) => {
  let calls = 0;
  const app = await setup({ execute: async () => { calls++; throw new Error('should not run'); } }); t.after(app.close);
  const turn = envelope();
  turn.issuedAt = new Date(Date.now() - 5000).toISOString();
  turn.deadlineAt = new Date(Date.now() - 1000).toISOString();
  const response = await app.post(JSON.stringify(turn));
  assert.equal(response.status, 503);
  assert.equal(response.body.error, 'TURN_UNAVAILABLE');
  assert.equal(calls, 0);
});

test('deadline aborts slow dependency, returns HOLD, and never repeats reserved work', async (t) => {
  let calls = 0;
  let aborted = false;
  const app = await setup({ execute: async (_turn, signal) => {
    calls++;
    return await new Promise((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('abort')); }, { once: true }));
  } }); t.after(app.close);
  const turn = envelope();
  const started = Date.now();
  const first = await app.post(JSON.stringify(turn));
  assert(Date.now() - started < 1500);
  assert.equal(aborted, true);
  assert.deepEqual(first.body.action, HOLD);
  assert.equal((await app.post(JSON.stringify(turn))).raw, first.raw);
  assert.equal(calls, 1);
});

test('concurrent duplicate requests share one operation and one signed result', async (t) => {
  let calls = 0;
  const app = await setup({ execute: async () => { calls++; await new Promise((resolve) => setTimeout(resolve, 20)); throw new Error('transport fixture failure'); } }); t.after(app.close);
  const body = JSON.stringify(envelope());
  const [a, b] = await Promise.all([app.post(body), app.post(body)]);
  assert.equal(a.raw, b.raw);
  assert.equal(calls, 1);
});

test('a reservation surviving a crash is HOLD, never a second Kurier POST', async (t) => {
  let calls = 0;
  const app = await setup({ execute: async () => { calls++; throw new Error('should not run'); } }); t.after(app.close);
  const turn = envelope();
  await app.store.reserve(turnKey(turn), turnFingerprint(turn));
  assert.deepEqual((await app.post(JSON.stringify(turn))).body.action, HOLD);
  assert.equal(calls, 0);
});

test('competition turns are disabled by default on testnet', async (t) => {
  let calls = 0;
  const app = await setup({ execute: async () => { calls++; throw new Error('should not run'); } }); t.after(app.close);
  assert.deepEqual((await app.post(JSON.stringify({ ...envelope(), mode: 'competition' }))).body.action, HOLD);
  assert.equal(calls, 0);
});

test('successful mocked pipeline serializes proof and echoes public envelope fields', async (t) => {
  // This tests serialization only. It is not a valid cryptographic proof or a chosen strategy.
  const proofReference = `0x${'a'.repeat(64)}`;
  const app = await setup({ execute: async (turn) => ({ action: HOLD, hash: publicInputsHash(turn, HOLD), bundle: { proof: { testOnly: true }, publicSignals: [] }, proofReference }) }); t.after(app.close);
  const turn = envelope();
  const result = await app.post(JSON.stringify(turn));
  assert.equal(result.body.policyProof.proofReference, proofReference);
  assert.deepEqual(result.body.proof, { testOnly: true });
  assert.deepEqual(result.body.public_signals, []);
  assert.equal(result.body.matchId, turn.matchId);
  assert.equal(result.body.turn, turn.turn);
  assert.deepEqual(result.body.action, HOLD);
});
