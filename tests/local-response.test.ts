import assert from 'node:assert/strict';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../src/config.js';
import { createAgentServer } from '../src/server.js';
import { SIGNATURE_HEADER, sign, verifySignature } from '../src/protocol/hmac.js';
import { type TurnEnvelope } from '../src/protocol/schema.js';
import { publicInputsHash } from '../src/protocol/hash.js';
import { verifyArtifacts } from '../src/proving/artifacts.js';
import { WorkerProver } from '../src/proving/prover.js';
import { OFFICIAL_CIRCUIT, type StrategyParams } from '../src/strategy/contract.js';
import { computeCommitment } from '../src/strategy/commitment.js';
import { policy, policyState } from '../src/strategy/policy.js';
import { ProofEngine } from '../src/runtime/engine.js';
import { FileTurnStore } from '../src/runtime/store.js';
import { TurnService } from '../src/runtime/turn-service.js';

// Real local proof + signed HTTP response, no network finality service or production secrets.
test('local proof response meets a 14.75-second practice deadline without a chain reference', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vfy-local-response-'));
  const params: StrategyParams = [BigInt(randomInt(1, 11)), BigInt(randomInt(1, 1000)),
    BigInt(randomInt(1, 1000)), BigInt(randomInt(0, 2)), 0n, 0n, 0n, 0n];
  const salt = BigInt(`0x${randomBytes(31).toString('hex')}`);
  const commitment = await computeCommitment(OFFICIAL_CIRCUIT, params, salt);
  const secret = randomBytes(32).toString('hex');
  const config = loadConfig({ AGENT_GAMES_HMAC_SECRET: secret, DATA_DIRECTORY: directory });
  const store = new FileTurnStore(directory);
  await store.initialize();
  const artifacts = await verifyArtifacts(fileURLToPath(new URL('../../artifacts/', import.meta.url)));
  const engine = new ProofEngine(OFFICIAL_CIRCUIT, params, salt, commitment, new WorkerProver(artifacts, 1));
  const server = createAgentServer(config, new TurnService(config, store, engine), commitment);
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const now = Date.now();
    const turn: TurnEnvelope = { protocolVersion: 'v1', eventId: 'steal-the-vfy', mode: 'practice',
      matchId: randomUUID(), turn: 1, issuedAt: new Date(now).toISOString(), deadlineAt: new Date(now + 14_750).toISOString(),
      state: { selfBalance: params[1].toString(), opponentBalance: params[2].toString(),
        selfFortifiedUntilTurn: null, opponentFortifiedUntilTurn: null },
      strategyCommitment: { hash: commitment }, resolverVersion: 'v1', nonce: 'public-http-fixture' };
    const { strategyCommitment: _omitted, ...practiceInput } = turn;
    const raw = JSON.stringify(practiceInput);
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/agent`, {
      method: 'POST', headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: sign(raw, secret) },
      body: raw, signal: AbortSignal.timeout(14_750),
    });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert(verifySignature(Buffer.from(body), response.headers.get(SIGNATURE_HEADER) ?? undefined, secret));
    const data = JSON.parse(body) as Record<string, any>;
    assert.equal(data.matchId, turn.matchId);
    assert.equal(data.turn, turn.turn);
    assert.equal('proofReference' in data.policyProof, false);
    assert.equal('proof' in data, false);
    assert.equal('public_signals' in data, false);
    assert(data.policyProof.proof?.protocol === 'groth16', 'response must contain the real locally verified proof');
    const action = policy(policyState(turn), params);
    const expected = await OFFICIAL_CIRCUIT.expectedPublicSignals(turn, action);
    assert(data.policyProof.public_signals.length === 9 && expected.every((word, i) => data.policyProof.public_signals[i] === word));
    assert.equal(data.policyProof.publicInputsHash, publicInputsHash(turn, action));
    assert(Date.now() < now + 14_750, 'response must finish before the observed platform deadline');
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  }
});
