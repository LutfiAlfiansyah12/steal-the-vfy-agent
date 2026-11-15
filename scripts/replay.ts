import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../src/config.js';
import { createAgentServer } from '../src/server.js';
import { SIGNATURE_HEADER, sign, verifySignature } from '../src/protocol/hmac.js';
import { FileTurnStore } from '../src/runtime/store.js';
import { TurnService } from '../src/runtime/turn-service.js';

// Self-contained loopback harness. No production credentials, policy, or network submission.
const directory = await mkdtemp(join(tmpdir(), 'vfy-replay-'));
const secret = randomBytes(32).toString('hex');
const config = loadConfig({ AGENT_GAMES_HMAC_SECRET: secret, DATA_DIRECTORY: directory });
const store = new FileTurnStore(directory);
await store.initialize();
const server = createAgentServer(config, new TurnService(config, store));
try {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/agent`;
  async function post(body: string, signature = sign(body, secret)): Promise<{ status: number; raw: string }> {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signature }, body });
    const raw = await response.text();
    assert(verifySignature(Buffer.from(raw), response.headers.get(SIGNATURE_HEADER) ?? undefined, secret));
    return { status: response.status, raw };
  }
  const preflight = JSON.stringify({ type: 'agent-games.preflight.v1', agent_id: 'agt_local', issued_at: new Date().toISOString(), nonce: 'public-test-nonce' });
  assert.equal((await post(preflight)).raw, '{"ok":true,"protocolVersion":"v1"}');
  assert.equal((await post(preflight, '0'.repeat(64))).status, 401);
  const turn = JSON.stringify({
    protocolVersion: 'v1', eventId: 'steal-the-vfy', mode: 'practice',
    matchId: '00000000-0000-4000-8000-000000000001', turn: 1,
    issuedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    state: { selfBalance: '100', opponentBalance: '100', selfFortifiedUntilTurn: null, opponentFortifiedUntilTurn: null },
    strategyCommitment: { hash: `0x${'0'.repeat(64)}` }, resolverVersion: 'v1', nonce: 'public-turn-nonce',
  });
  const response = await post(turn);
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.raw).action, { type: 'HOLD' });
  assert.equal((await post(turn)).raw, response.raw);
  process.stdout.write('PASS: signed preflight, invalid-signature rejection, fail-closed HOLD, and exact duplicate replay. No proof or chain call performed.\n');
} finally {
  await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  await rm(directory, { recursive: true, force: true });
}
