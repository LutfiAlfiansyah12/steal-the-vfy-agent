import assert from 'node:assert/strict';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { buildPoseidon } from 'circomlibjs';
import { FIELD_MODULUS, type Action, type TurnEnvelope } from '../src/protocol/schema.js';
import { verifyArtifacts } from '../src/proving/artifacts.js';
import { WorkerProver, type Proven } from '../src/proving/prover.js';
import { computeCommitment } from '../src/strategy/commitment.js';
import { OFFICIAL_CIRCUIT, type StrategyParams } from '../src/strategy/contract.js';
import { policy, policyState } from '../src/strategy/policy.js';
import { TurnFailure } from '../src/runtime/deadline.js';

// Draw fresh synthetic test secrets; never read the owner's environment or write
// parameters, witnesses, or proofs to disk. No test assertion prints their values.
function randomField(): bigint {
  for (;;) {
    const value = BigInt(`0x${randomBytes(32).toString('hex')}`);
    if (value < FIELD_MODULUS) return value;
  }
}
function syntheticParams(): StrategyParams {
  return Object.freeze([
    BigInt(randomInt(1, 11)), randomField(), randomField(),
    BigInt(randomInt(0, 2)), 0n, 0n, 0n, 0n,
  ] as const);
}
function field(value: bigint): bigint {
  return ((value % FIELD_MODULUS) + FIELD_MODULUS) % FIELD_MODULUS;
}

// snarkjs retains curve workers, and its web-worker dependency cannot construct
// nested workers inside a Node Worker. Verify in a child process, then terminate
// that process and its threads even on failure, timeout, or test cancellation.
async function verifyIndependently(cases: readonly Proven[], signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) throw new Error('Independent proof verification aborted');
  const script = `
    // File-based curve workers must not inherit this process's eval-only flags.
    process.execArgv = [];
    try {
      let input = '';
      for await (const chunk of process.stdin) input += chunk.toString('utf8');
      const data = JSON.parse(input);
      const { groth16 } = await import(data.snarkjsUrl);
      const modulus = BigInt(data.modulus);
      const checks = [];
      for (const { bundle, verificationKey } of data.cases) {
        const row = [await groth16.verify(verificationKey, bundle.publicSignals, bundle.proof)];
        for (let index = 0; index < 9; index++) {
          const changed = [...bundle.publicSignals];
          changed[index] = ((BigInt(changed[index]) + 1n) % modulus).toString();
          row.push(!await groth16.verify(verificationKey, changed, bundle.proof));
        }
        checks.push(row);
      }
      process.stdout.write(JSON.stringify({ ok: true, checks }) + '\\n');
    } catch {
      process.stdout.write(JSON.stringify({ ok: false }) + '\\n');
    }
  `;
  const env: NodeJS.ProcessEnv = {};
  if (process.platform === 'win32' && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = new Promise<void>((resolve) => { child.once('close', () => resolve()); });
  let abort: (() => void) | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<unknown>((resolve, reject) => {
      let settled = false;
      let stdout = '';
      let outputBytes = 0;
      const fail = (): void => {
        if (settled) return;
        settled = true;
        reject(new Error('Independent proof verification failed or was cancelled'));
      };
      abort = fail;
      child.once('error', fail);
      child.once('close', fail);
      child.stdin.once('error', fail);
      child.stdout.once('error', fail);
      child.stderr.once('error', fail);
      child.stderr.on('data', (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > 16_384) fail();
      });
      child.stdout.on('data', (chunk: Buffer) => {
        if (settled) return;
        outputBytes += chunk.length;
        if (outputBytes > 16_384) { fail(); return; }
        stdout += chunk.toString('utf8');
        if (!stdout.includes('\n')) return;
        try {
          const message: unknown = JSON.parse(stdout);
          if (typeof message !== 'object' || message === null || !('ok' in message) || message.ok !== true
            || !('checks' in message) || !Array.isArray(message.checks)
            || message.checks.length !== cases.length
            || !message.checks.every((row: unknown) => Array.isArray(row) && row.length === 10
              && row.every((value: unknown) => typeof value === 'boolean'))) {
            fail(); return;
          }
          settled = true;
          resolve(message.checks);
        } catch { fail(); }
      });
      timer = setTimeout(fail, 25_000);
      signal.addEventListener('abort', fail, { once: true });
      if (signal.aborted) { fail(); return; }
      child.stdin.end(JSON.stringify({ cases, modulus: FIELD_MODULUS.toString(), snarkjsUrl: import.meta.resolve('snarkjs') }));
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal.removeEventListener('abort', abort);
    child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  }
}

const SIGNAL_NAMES = ['binding', 'commitment', 'matchId', 'turnNumber', 'selfBalance',
  'opponentBalance', 'action', 'amount', 'circuitVersion'] as const;
const ACTION_TYPES = ['FORTIFY', 'EXTRACT', 'HOLD'] as const;

test('official local artifacts prove all three actions and reject mutations of all nine public signals', { timeout: 60_000 }, async (context) => {
  // npm test compiles this file to dist/tests; the artifacts remain at project root.
  const artifacts = await verifyArtifacts(fileURLToPath(new URL('../../artifacts/', import.meta.url)));
  const prover = new WorkerProver(artifacts, 1);
  const poseidon = await buildPoseidon();
  const hash = (words: bigint[]): bigint => BigInt(poseidon.F.toString(poseidon(words)));
  const cases: Proven[] = [];

  for (const type of ACTION_TYPES) {
    await context.test(`${type} produces a real proof with independently calculated public signals`, async () => {
      // Rejection-sample the extraction-enabling flag for that branch only. All
      // free parameter values remain random; public balances select the branch.
      let params: StrategyParams;
      do { params = syntheticParams(); } while (type === 'EXTRACT' && params[3] !== 0n);
      const salt = randomField();
      const commitment = await computeCommitment(OFFICIAL_CIRCUIT, params, salt);
      assert.ok(BigInt(commitment) === hash([...params, salt]), 'commitment must match independent Poseidon');
      const turn: TurnEnvelope = {
        protocolVersion: 'v1', eventId: 'steal-the-vfy', mode: 'practice',
        matchId: randomUUID(), turn: randomInt(0, 21),
        issuedAt: '2026-11-15T12:00:00.000Z', deadlineAt: '2026-11-15T12:01:00.000Z',
        state: {
          selfBalance: String(type === 'FORTIFY' ? field(params[1] - 1n) : params[1]),
          opponentBalance: String(type === 'HOLD' ? params[2] : field(params[2] + 1n)),
          selfFortifiedUntilTurn: null, opponentFortifiedUntilTurn: null,
        },
        strategyCommitment: { hash: commitment }, resolverVersion: 'v1', nonce: 'synthetic-local-proof-test',
      };
      const action: Action = policy(policyState(turn), params);
      assert.ok(action.type === type, 'synthetic public state must exercise the requested action');
      const matchId = BigInt(`0x${turn.matchId.replaceAll('-', '')}`);
      const code = type === 'HOLD' ? 0n : type === 'FORTIFY' ? 1n : 2n;
      const amount = type === 'EXTRACT' ? params[0] : 0n;
      const expected = [hash([matchId, BigInt(turn.turn), 1n]), BigInt(commitment), matchId, BigInt(turn.turn),
        BigInt(turn.state.selfBalance), BigInt(turn.state.opponentBalance), code, amount, 1n].map(String);
      const declared = await OFFICIAL_CIRCUIT.expectedPublicSignals(turn, action);
      assert.ok(declared.length === 9 && declared.every((word, index) => word === expected[index]),
        'contract public signal order must match independent construction');
      const witness = OFFICIAL_CIRCUIT.buildWitness(turn, action, params, salt);
      if (type === 'FORTIFY') {
        const cancellation = new AbortController();
        const interrupted = prover.prove(witness, expected, cancellation.signal);
        cancellation.abort();
        await assert.rejects(interrupted, (error: unknown) => error instanceof TurnFailure && error.code === 'DEADLINE');
        // A subsequent real proof must work: cancellation releases capacity and kills the child.
      }
      const proven = await prover.prove(witness, expected, context.signal);
      assert.ok(proven.bundle.publicSignals.length === 9
        && proven.bundle.publicSignals.every((word, index) => word === expected[index]),
      'real proof must match every expected public signal');
      assert.ok(proven.verificationKey.protocol === 'groth16' && proven.verificationKey.curve === 'bn128'
        && proven.verificationKey.nPublic === 9, 'proof must use the official verification key shape');
      cases.push(proven);
    });
  }

  assert.ok(cases.length === ACTION_TYPES.length, 'every branch must finish a real local proof');
  const checks = await verifyIndependently(cases, context.signal);
  assert.ok(Array.isArray(checks) && checks.length === ACTION_TYPES.length, 'independent verifier must return all branch results');
  for (let branch = 0; branch < ACTION_TYPES.length; branch++) {
    const row: unknown = checks[branch];
    assert.ok(Array.isArray(row) && row.length === SIGNAL_NAMES.length + 1, 'independent verifier must check each public signal');
    assert.ok(row[0] === true, `${ACTION_TYPES[branch]} proof must pass independent snarkjs verification`);
    for (let index = 0; index < SIGNAL_NAMES.length; index++) {
      assert.ok(row[index + 1] === true, `${ACTION_TYPES[branch]} proof must reject a changed ${SIGNAL_NAMES[index]}`);
    }
  }
});
