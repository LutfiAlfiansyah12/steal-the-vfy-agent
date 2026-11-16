import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { OFFICIAL_CIRCUIT } from '../src/strategy/contract.js';
import { STRATEGY_PARAMS, loadPrivateParams, fieldElement } from '../src/strategy/params.js';
import { policy } from '../src/strategy/policy.js';
import { validatePublicSignals } from '../src/proving/prover.js';
import { FIELD_MODULUS } from '../src/protocol/schema.js';

test('verified circuit is available but no default strategy values are supplied', () => {
  assert.equal(STRATEGY_PARAMS, undefined);
  assert.equal(OFFICIAL_CIRCUIT.circuitVersion, 'v1');
  assert.throws(() => policy({ turn: 1, selfBalance: 100n, opponentBalance: 100n, selfFortifiedUntilTurn: null, opponentFortifiedUntilTurn: null }));
  assert.throws(() => loadPrivateParams({}));
});

test('private input parser rejects missing/malformed data without reflecting it', () => {
  for (const value of ['{"secretLeakMarker":', '[]', 'null', '{"secretLeakMarker": 1}', '{"__proto__":"1"}']) {
    assert.throws(() => loadPrivateParams({ STRATEGY_PARAMS_JSON: value }), (error: unknown) => error instanceof Error && !error.message.includes('secretLeakMarker'));
  }
  assert.throws(() => fieldElement(FIELD_MODULUS.toString()));
  assert.throws(() => fieldElement('-1'));
  assert.throws(() => fieldElement(undefined));
});

test('private parameter parser preserves array order and never supplies defaults', () => {
  const amount = BigInt(1 + randomBytes(1)[0]! % 10);
  const selfThreshold = BigInt(randomBytes(2).readUInt16BE());
  const opponentThreshold = BigInt(randomBytes(2).readUInt16BE());
  const flag = BigInt(randomBytes(1)[0]! % 2);
  const fixture = [amount, selfThreshold, opponentThreshold, flag, 0n, 0n, 0n, 0n];
  const loaded = loadPrivateParams({ STRATEGY_PARAMS_JSON: JSON.stringify(fixture.map(String)) });
  assert(loaded.every((value, index) => value === fixture[index]));
  assert.equal(Object.isFrozen(loaded), true);
  for (const malformed of [fixture.slice(1).map(String), [...fixture, 0n].map(String), fixture.map(Number)]) {
    assert.throws(() => loadPrivateParams({ STRATEGY_PARAMS_JSON: JSON.stringify(malformed) }));
  }
});

test('configuration is Volta-only and requires real environment setup', () => {
  assert.throws(() => loadConfig({}));
  const env = { AGENT_GAMES_HMAC_SECRET: randomBytes(32).toString('hex') };
  assert.equal(loadConfig(env).allowCompetition, false);
  assert.equal(loadConfig(env).proofVerificationMode, 'local');
  assert.equal(loadConfig({ ...env, PROOF_VERIFICATION_MODE: 'finalized' }).proofVerificationMode, 'finalized');
  assert.throws(() => loadConfig({ ...env, PROOF_VERIFICATION_MODE: 'skip' }));
  assert.throws(() => loadConfig({ ...env, ZKVERIFY_NETWORK: 'mainnet' }));
  assert.throws(() => loadConfig({ ...env, MAX_TURN_MS: '60000' }));
  assert.throws(() => loadConfig({ ...env, MAX_CONCURRENT_PROOFS: 'NaN' }));
});

test('nine canonical scalar-field public signals are required; no modulus reduction', () => {
  assert.doesNotThrow(() => validatePublicSignals(Array<string>(9).fill('0')));
  assert.throws(() => validatePublicSignals(Array<string>(8).fill('0')));
  assert.throws(() => validatePublicSignals(Array<string>(9).fill(FIELD_MODULUS.toString())));
  assert.throws(() => validatePublicSignals(Array<string>(9).fill('00')));
});
