import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { publicInputsHash } from '../src/protocol/hash.js';
import { turnSchema, type Action, type TurnEnvelope } from '../src/protocol/schema.js';
import type { Proven, Prover } from '../src/proving/prover.js';
import { TurnFailure } from '../src/runtime/deadline.js';
import { ProofEngine } from '../src/runtime/engine.js';
import { computeCommitment } from '../src/strategy/commitment.js';
import { OFFICIAL_CIRCUIT, type CircuitContract, type StrategyParams } from '../src/strategy/contract.js';
import { policyState } from '../src/strategy/policy.js';
import type { Verifier } from '../src/verification/kurier.js';

// One synthetic private fixture, generated in memory and shared by the engine and CLI checks.
// Reserved slots obey the circuit; these are not production defaults or a suggested strategy.
const params: StrategyParams = Object.freeze([
  BigInt(randomInt(1, 11)),
  BigInt(randomInt(1, 65_536)),
  BigInt(randomInt(1, 65_536)),
  BigInt(randomInt(0, 2)),
  0n, 0n, 0n, 0n,
] satisfies StrategyParams);
const salt = BigInt(`0x${randomBytes(31).toString('hex')}`); // 248 bits is below the scalar modulus.
const finalizedTxHash = `0x${'ab'.repeat(32)}`;

interface Fixture {
  commitment: `0x${string}`;
  envelope: TurnEnvelope;
  action: Action;
  hash: `0x${string}`;
  publicSignals: readonly string[];
}
let fixture: Fixture;

before(async () => {
  const commitment = await computeCommitment(OFFICIAL_CIRCUIT, params, salt);
  const envelope = turnSchema.parse({
    protocolVersion: 'v1',
    eventId: 'steal-the-vfy',
    mode: 'practice',
    matchId: '00112233-4455-6677-8899-aabbccddeeff',
    turn: 7,
    issuedAt: '2026-11-15T12:00:00.000Z',
    deadlineAt: '2026-11-15T12:00:55.000Z',
    state: {
      selfBalance: '32768',
      opponentBalance: '32768',
      selfFortifiedUntilTurn: null,
      opponentFortifiedUntilTurn: null,
    },
    strategyCommitment: { hash: commitment },
    resolverVersion: 'v1',
    nonce: 'engine-control-flow-fixture',
  });
  const action = OFFICIAL_CIRCUIT.policy(policyState(envelope), params);
  fixture = {
    commitment,
    envelope,
    action,
    hash: publicInputsHash(envelope, action),
    publicSignals: await OFFICIAL_CIRCUIT.expectedPublicSignals(envelope, action),
  };
});

// These stubs test engine control flow only. Neither object is a valid cryptographic proof/key,
// and the verifier never contacts Kurier or claims to perform real proof verification.
function fakeProven(publicSignals: readonly string[]): Proven {
  return {
    bundle: { proof: { fixture: 'not-a-cryptographic-proof' }, publicSignals: [...publicSignals] },
    verificationKey: { fixture: 'not-a-verification-key' },
  };
}

interface Overrides {
  policy?: CircuitContract['policy'];
  expectedPublicSignals?: CircuitContract['expectedPublicSignals'];
  prove?: Prover['prove'];
  submitAndFinalize?: Verifier['submitAndFinalize'];
}

function harness(overrides: Overrides = {}): { engine: ProofEngine; events: string[] } {
  const events: string[] = [];
  const contract: CircuitContract = {
    ...OFFICIAL_CIRCUIT,
    policy(state, privateParams) {
      events.push('policy');
      return (overrides.policy ?? OFFICIAL_CIRCUIT.policy)(state, privateParams);
    },
    async expectedPublicSignals(envelope, action) {
      events.push('signals');
      return (overrides.expectedPublicSignals ?? OFFICIAL_CIRCUIT.expectedPublicSignals)(envelope, action);
    },
    buildWitness(envelope, action, privateParams, privateSalt) {
      events.push('witness');
      return OFFICIAL_CIRCUIT.buildWitness(envelope, action, privateParams, privateSalt);
    },
  };
  const prover: Prover = {
    async prove(witness, expectedSignals, signal) {
      events.push('prove');
      return overrides.prove ? overrides.prove(witness, expectedSignals, signal) : fakeProven(expectedSignals);
    },
  };
  const verifier: Verifier = {
    async submitAndFinalize(bundle, verificationKey, signal) {
      events.push('submit');
      return overrides.submitAndFinalize
        ? overrides.submitAndFinalize(bundle, verificationKey, signal)
        : { jobId: 'control-flow-only-job', txHash: finalizedTxHash };
    },
  };
  return {
    engine: new ProofEngine(contract, params, salt, fixture.commitment, prover, verifier),
    events,
  };
}

async function expectFailure(operation: Promise<unknown>, code: TurnFailure['code']): Promise<void> {
  await assert.rejects(operation, (error: unknown) => error instanceof TurnFailure && error.code === code);
}

test('engine rejects a mismatched commitment before policy, proving, or submission', async () => {
  const envelope = structuredClone(fixture.envelope);
  const wrongCommitment = BigInt(fixture.commitment) === 0n ? 1n : 0n;
  envelope.strategyCommitment.hash = `0x${wrongCommitment.toString(16).padStart(64, '0')}`;
  const { engine, events } = harness();
  await expectFailure(engine.execute(envelope, new AbortController().signal), 'INVALID_PROOF');
  assert.deepEqual(events, []);
});

for (const [label, index] of [['binding', 0], ['last public input', 8]] as const) {
  test(`engine rejects an altered ${label} before submission`, async () => {
    const { engine, events } = harness({
      async prove(_witness, expectedSignals) {
        const proven = fakeProven(expectedSignals);
        // Still a canonical scalar: failure must come from comparison with the expected value.
        proven.bundle.publicSignals[index] = expectedSignals[index] === '0' ? '1' : '0';
        return proven;
      },
    });
    await expectFailure(engine.execute(structuredClone(fixture.envelope), new AbortController().signal), 'INVALID_PROOF');
    assert.deepEqual(events, ['policy', 'signals', 'witness', 'prove']);
  });
}

for (const balance of ['selfBalance', 'opponentBalance'] as const) {
  test(`engine rejects ${balance} outside the policy comparison domain before proving or submission`, async () => {
    const envelope = structuredClone(fixture.envelope);
    envelope.state[balance] = '131072';
    const { engine, events } = harness();
    await assert.rejects(
      engine.execute(envelope, new AbortController().signal),
      /State outside circuit comparison domain/,
    );
    assert.deepEqual(events, ['policy']);
  });
}

test('engine rejects an invalid policy action before proving or submission', async () => {
  const { engine, events } = harness({ policy: () => ({ type: 'EXTRACT', amount: 0 }) });
  await assert.rejects(engine.execute(structuredClone(fixture.envelope), new AbortController().signal));
  assert.deepEqual(events, ['policy']);
});

test('engine rejects a schema-valid action that conflicts with the committed policy before proving or submission', async () => {
  const wrongAction: Action = fixture.action.type === 'HOLD' ? { type: 'FORTIFY' } : { type: 'HOLD' };
  const { engine, events } = harness({ policy: () => wrongAction });
  await assert.rejects(
    engine.execute(structuredClone(fixture.envelope), new AbortController().signal),
    /Action does not match the committed circuit policy/,
  );
  assert.deepEqual(events, ['policy', 'signals', 'witness']);
});

for (const [stage, expectedEvents] of [
  ['before execution', []],
  ['signal derivation', ['policy', 'signals']],
  ['proving', ['policy', 'signals', 'witness', 'prove']],
] as const) {
  test(`engine cancellation during ${stage} prevents submission`, async () => {
    const controller = new AbortController();
    const { engine, events } = harness({
      async expectedPublicSignals(envelope, action) {
        const signals = await OFFICIAL_CIRCUIT.expectedPublicSignals(envelope, action);
        if (stage === 'signal derivation') controller.abort();
        return signals;
      },
      async prove(_witness, expectedSignals) {
        if (stage === 'proving') controller.abort();
        return fakeProven(expectedSignals);
      },
    });
    if (stage === 'before execution') controller.abort();
    await expectFailure(engine.execute(structuredClone(fixture.envelope), controller.signal), 'DEADLINE');
    assert.deepEqual(events, expectedEvents);
  });
}

test('engine computes the audit hash before proving and submission and returns the finalized reference', async () => {
  const envelope = structuredClone(fixture.envelope);
  envelope.strategyCommitment.hash = `0x${fixture.commitment.slice(2).toUpperCase()}`;
  const controller = new AbortController();
  let proven: Proven | undefined;
  const { engine, events } = harness({
    async prove(_witness, expectedSignals, signal) {
      assert.equal(signal, controller.signal);
      assert.deepEqual(expectedSignals, fixture.publicSignals);
      proven = fakeProven(expectedSignals);
      // A mutation inside the stub makes deferring the audit hash until after proving observable.
      // The stub still returns the original public signals; this is not a claim of proof validity.
      envelope.turn += 1;
      return proven;
    },
    async submitAndFinalize(bundle, verificationKey, signal) {
      assert.ok(proven);
      assert.equal(bundle, proven.bundle);
      assert.equal(verificationKey, proven.verificationKey);
      assert.equal(signal, controller.signal);
      return { jobId: 'control-flow-only-job', txHash: finalizedTxHash };
    },
  });
  const evidence = await engine.execute(envelope, controller.signal);
  assert.deepEqual(events, ['policy', 'signals', 'witness', 'prove', 'submit']);
  assert.deepEqual(evidence.action, fixture.action);
  assert.equal(evidence.hash, fixture.hash);
  assert.notEqual(publicInputsHash(envelope, fixture.action), fixture.hash);
  assert.equal(evidence.proofReference, finalizedTxHash);
  assert.ok(proven);
  assert.equal(evidence.bundle, proven.bundle);
});

test('engine rejects a malformed finalized transaction reference', async () => {
  const { engine, events } = harness({
    async submitAndFinalize() {
      return { jobId: 'control-flow-only-job', txHash: '0x1234' };
    },
  });
  await expectFailure(engine.execute(structuredClone(fixture.envelope), new AbortController().signal), 'VERIFICATION');
  assert.deepEqual(events, ['policy', 'signals', 'witness', 'prove', 'submit']);
});

test('compiled commitment CLI writes only a padded hash with an isolated synthetic private environment', { timeout: 45_000 }, async () => {
  // Do not inherit production keys, NODE_OPTIONS, or an env-file loader. Invoke Node directly.
  const env: NodeJS.ProcessEnv = {
    STRATEGY_PARAMS_JSON: JSON.stringify(params.map(String)),
    STRATEGY_SALT: salt.toString(),
  };
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP'] as const) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    // From dist/tests/engine.test.js this resolves to dist/scripts/commitment.js.
    const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/commitment.js', import.meta.url))], {
      cwd: new URL('../', import.meta.url),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: 30_000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', () => reject(new Error('Commitment CLI could not be started')));
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0, 'Commitment CLI must succeed with synthetic private inputs');
  // Boolean assertions intentionally prevent captured output from appearing in failure diagnostics.
  // Exact output also excludes parameter/salt logs; individual short scalars can occur in any hash.
  assert.ok(/^0x[0-9a-f]{64}\n$/.test(result.stdout), 'CLI stdout must contain only one padded hash line');
  assert.ok(result.stdout === `${fixture.commitment}\n`, 'CLI commitment must match the in-memory computation');
  assert.ok(result.stderr === '', 'CLI stderr must be empty');
});
