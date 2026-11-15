import assert from 'node:assert/strict';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { buildPoseidon } from 'circomlibjs';
import { FIELD_MODULUS, type Action, type TurnEnvelope } from '../src/protocol/schema.js';
import { OFFICIAL_CIRCUIT, type PolicyState, type StrategyParams } from '../src/strategy/contract.js';
import { computeCommitment } from '../src/strategy/commitment.js';
import { policy } from '../src/strategy/policy.js';

// Ephemeral synthetic inputs only. Assertions deliberately compare booleans so
// failures cannot dump a private tuple, salt, or witness into test output.
function randomField(): bigint {
  for (;;) {
    const value = BigInt(`0x${randomBytes(32).toString('hex')}`);
    if (value < FIELD_MODULUS) return value;
  }
}
function syntheticParams(): StrategyParams {
  const threshold = (): bigint => {
    for (;;) {
      const value = randomField();
      if (value > (1n << 128n) && value < FIELD_MODULUS - 65537n) return value;
    }
  };
  const selfThreshold = threshold();
  let opponentThreshold = threshold();
  while (opponentThreshold === selfThreshold) opponentThreshold = threshold();
  return Object.freeze([
    BigInt(randomInt(1, 11)), selfThreshold, opponentThreshold,
    BigInt(randomInt(0, 2)), 0n, 0n, 0n, 0n,
  ] as const);
}
function replaceParam(params: StrategyParams, index: number, value: unknown): StrategyParams {
  return Object.freeze(params.map((word, position) => position === index ? value : word)) as unknown as StrategyParams;
}
function field(value: bigint): bigint {
  return ((value % FIELD_MODULUS) + FIELD_MODULUS) % FIELD_MODULUS;
}
function state(selfBalance: bigint, opponentBalance: bigint): PolicyState {
  return { turn: 1, selfBalance, opponentBalance, selfFortifiedUntilTurn: null, opponentFortifiedUntilTurn: null };
}
function expectAction(input: PolicyState, params: StrategyParams, type: Action['type']): void {
  const actual = policy(input, params);
  assert.ok(actual.type === type, 'policy must select the expected branch');
  assert.ok(actual.type === 'EXTRACT'
    ? actual.amount === Number(params[0])
    : !Object.hasOwn(actual, 'amount'), 'only EXTRACT carries the ordered extraction amount');
}
function expectRejected(run: () => unknown, label = 'invalid circuit input'): void {
  let rejected = false;
  try { run(); } catch { rejected = true; }
  assert.ok(rejected, `${label} must be rejected`);
}
async function expectRejectedAsync(run: () => Promise<unknown>): Promise<void> {
  let rejected = false;
  try { await run(); } catch { rejected = true; }
  assert.ok(rejected, 'invalid circuit input must be rejected');
}
function envelope(selfBalance: bigint, opponentBalance: bigint, commitment: string): TurnEnvelope {
  return {
    protocolVersion: 'v1', eventId: 'steal-the-vfy', mode: 'practice',
    matchId: randomUUID(), turn: randomInt(0, 21),
    issuedAt: '2026-11-15T12:00:00.000Z', deadlineAt: '2026-11-15T12:01:00.000Z',
    state: { selfBalance: String(selfBalance), opponentBalance: String(opponentBalance),
      selfFortifiedUntilTurn: null, opponentFortifiedUntilTurn: null },
    strategyCommitment: { hash: commitment }, resolverVersion: 'v1', nonce: 'synthetic-circuit-test',
  };
}
let poseidonPromise: ReturnType<typeof buildPoseidon> | undefined;
async function independentPoseidon(words: readonly bigint[]): Promise<bigint> {
  const poseidon = await (poseidonPromise ??= buildPoseidon());
  return BigInt(poseidon.F.toString(poseidon([...words])));
}

test('policy preserves strict threshold equality for field-sized balances and prioritizes FORTIFY', () => {
  const sample = syntheticParams();
  for (const flag of [0n, 1n]) {
    const params = replaceParam(sample, 3, flag);
    const [, self, opponent] = params;
    expectAction(state(self - 1n, opponent + 1n), params, 'FORTIFY');
    expectAction(state(self - 1n, opponent - 1n), params, 'FORTIFY');
    expectAction(state(self, opponent), params, 'HOLD');
    expectAction(state(self, opponent - 1n), params, 'HOLD');
    expectAction(state(self + 1n, opponent), params, 'HOLD');
    expectAction(state(self, opponent + 1n), params, flag === 0n ? 'EXTRACT' : 'HOLD');
    expectAction(state(self + 1n, opponent + 1n), params, flag === 0n ? 'EXTRACT' : 'HOLD');
  }
});

test('every legal extraction amount comes from parameter zero, independently of turn and fortification metadata', () => {
  const sample = replaceParam(syntheticParams(), 3, 0n);
  for (let amount = 1n; amount <= 10n; amount++) {
    const params = replaceParam(sample, 0, amount);
    OFFICIAL_CIRCUIT.validateParams(params);
    for (const turn of [0, 20]) {
      expectAction({ ...state(params[1], params[2] + 1n), turn,
        selfFortifiedUntilTurn: 20, opponentFortifiedUntilTurn: 20 }, params, 'EXTRACT');
    }
  }
});

for (const operand of ['self', 'opponent'] as const) {
  test(`${operand} comparator accepts shifted values zero through 131071 and rejects both adjacent limits`, () => {
    const params = replaceParam(syntheticParams(), 3, 0n);
    for (const difference of [-65536n, -1n, 0n, 65535n]) {
      const input = operand === 'self'
        ? state(field(params[1] + difference), params[2])
        : state(params[1], field(params[2] - difference));
      const expected = difference < 0n ? (operand === 'self' ? 'FORTIFY' : 'EXTRACT') : 'HOLD';
      expectAction(input, params, expected);
    }
    for (const difference of [-65537n, 65536n]) {
      const input = operand === 'self'
        ? state(field(params[1] + difference), params[2])
        : state(params[1], field(params[2] - difference));
      expectRejected(() => policy(input, params), `${operand} comparison outside its shifted bounds`);
    }
  });
}

test('both comparisons must be valid even when the low-balance branch or disabling flag determines the action', () => {
  const params = replaceParam(syntheticParams(), 3, 1n);
  for (const difference of [-65537n, 65536n]) {
    expectRejected(() => policy(state(params[1] - 1n, field(params[2] - difference)), params));
    expectRejected(() => policy(state(params[1], field(params[2] - difference)), params));
  }
});

test('canonical field endpoints use modular differences rather than ordinary integer comparisons', () => {
  const sample = replaceParam(syntheticParams(), 3, 0n);
  let params = replaceParam(sample, 1, 0n);
  expectAction(state(FIELD_MODULUS - 1n, params[2]), params, 'FORTIFY');
  params = replaceParam(sample, 1, FIELD_MODULUS - 1n);
  expectAction(state(0n, params[2]), params, 'HOLD');
  params = replaceParam(sample, 2, FIELD_MODULUS - 1n);
  expectAction(state(params[1], 0n), params, 'EXTRACT');
  params = replaceParam(sample, 2, 0n);
  expectAction(state(params[1], FIELD_MODULUS - 1n), params, 'HOLD');
});

test('parameter validation requires an ordered array of exactly eight bigint field elements', () => {
  const params = syntheticParams();
  OFFICIAL_CIRCUIT.validateParams(params);
  for (const invalid of [[], params.slice(0, 7), [...params, 0n], { ...params }, new Array(8), null]) {
    expectRejected(() => OFFICIAL_CIRCUIT.validateParams(invalid as unknown as StrategyParams));
  }
  for (let index = 0; index < 8; index++) {
    for (const invalid of [-1n, FIELD_MODULUS, FIELD_MODULUS + 1n, 0, '0', undefined]) {
      expectRejected(() => OFFICIAL_CIRCUIT.validateParams(replaceParam(params, index, invalid)));
    }
  }
  for (const index of [1, 2]) {
    for (const endpoint of [0n, FIELD_MODULUS - 1n]) {
      OFFICIAL_CIRCUIT.validateParams(replaceParam(params, index, endpoint));
    }
  }
});

test('amount bounds, the boolean flag, and all four reserved zero slots are enforced', () => {
  const params = syntheticParams();
  for (const amount of [0n, 11n, FIELD_MODULUS - 1n]) {
    expectRejected(() => OFFICIAL_CIRCUIT.validateParams(replaceParam(params, 0, amount)));
  }
  for (const flag of [0n, 1n]) OFFICIAL_CIRCUIT.validateParams(replaceParam(params, 3, flag));
  for (const flag of [2n, FIELD_MODULUS - 1n]) {
    expectRejected(() => OFFICIAL_CIRCUIT.validateParams(replaceParam(params, 3, flag)));
  }
  for (let index = 4; index < 8; index++) {
    const invalid = replaceParam(params, index, 1n);
    expectRejected(() => OFFICIAL_CIRCUIT.validateParams(invalid));
    expectRejected(() => policy(state(params[1], params[2]), invalid));
    expectRejected(() => OFFICIAL_CIRCUIT.commitmentInputs(invalid, randomField()));
  }
});

test('policy rejects noncanonical balance operands without reducing them modulo the field', () => {
  const params = syntheticParams();
  for (const invalid of [-1n, FIELD_MODULUS, FIELD_MODULUS + 1n]) {
    expectRejected(() => policy(state(invalid, params[2]), params));
    expectRejected(() => policy(state(params[1], invalid), params));
    expectRejected(() => policy(state(params[1] - 1n, invalid), params));
  }
});

test('commitment is Poseidon of all eight ordered parameters followed by the salt', async () => {
  const params = syntheticParams();
  const salt = randomField();
  const inputs = OFFICIAL_CIRCUIT.commitmentInputs(params, salt);
  assert.ok(inputs.length === 9 && params.every((word, index) => inputs[index] === word)
    && inputs[8] === salt, 'commitment input arity and order must match the circuit');
  const expected = await independentPoseidon([...params, salt]);
  const actual = await computeCommitment(OFFICIAL_CIRCUIT, params, salt);
  assert.ok(actual === `0x${expected.toString(16).padStart(64, '0')}`, 'commitment must match independent Poseidon');
  const swapped = replaceParam(replaceParam(params, 1, params[2]), 2, params[1]);
  assert.ok(await computeCommitment(OFFICIAL_CIRCUIT, swapped, salt) !== actual, 'parameter order must affect commitment');
  assert.ok(await computeCommitment(OFFICIAL_CIRCUIT, params, field(salt + 1n)) !== actual, 'salt must affect commitment');
});

test('all actions use the exact nine witness scalars, ordered private tuple, and nine public signals', async () => {
  const params = replaceParam(syntheticParams(), 3, 0n);
  const salt = randomField();
  const commitment = await computeCommitment(OFFICIAL_CIRCUIT, params, salt);
  const scenarios: ReadonlyArray<{ action: Action; self: bigint; opponent: bigint; code: bigint; amount: bigint }> = [
    { action: { type: 'FORTIFY' }, self: params[1] - 1n, opponent: params[2] + 1n, code: 1n, amount: 0n },
    { action: { type: 'EXTRACT', amount: Number(params[0]) }, self: params[1], opponent: params[2] + 1n, code: 2n, amount: params[0] },
    { action: { type: 'HOLD' }, self: params[1], opponent: params[2], code: 0n, amount: 0n },
  ];
  for (const scenario of scenarios) {
    const turn = envelope(scenario.self, scenario.opponent, commitment);
    const matchId = BigInt(`0x${turn.matchId.replaceAll('-', '')}`);
    const witness = OFFICIAL_CIRCUIT.buildWitness(turn, scenario.action, params, salt);
    const scalars = {
      commitment: BigInt(commitment).toString(), matchId: String(matchId), turnNumber: String(turn.turn),
      selfBalance: String(scenario.self), opponentBalance: String(scenario.opponent), action: String(scenario.code),
      amount: String(scenario.amount), circuitVersion: '1', salt: String(salt),
    };
    assert.ok(Object.keys(witness).length === 10 && Object.entries(scalars).every(([key, value]) => witness[key] === value),
      'witness must contain exactly the named circuit inputs');
    const privateWords = witness.strategyParams;
    assert.ok(Array.isArray(privateWords) && privateWords.length === 8
      && params.every((word, index) => privateWords[index] === String(word)), 'witness parameter order must be preserved');
    const binding = await independentPoseidon([matchId, BigInt(turn.turn), 1n]);
    const expected = [binding, BigInt(commitment), matchId, BigInt(turn.turn), scenario.self,
      scenario.opponent, scenario.code, scenario.amount, 1n].map(String);
    const signals = await OFFICIAL_CIRCUIT.expectedPublicSignals(turn, scenario.action);
    assert.ok(signals.length === 9 && signals.every((word, index) => word === expected[index]),
      'every public signal must match its independently constructed position');
  }
});

test('binding depends on numeric match ID, turn, and version, including uppercase UUID encoding', async () => {
  const params = syntheticParams();
  const commitment = await computeCommitment(OFFICIAL_CIRCUIT, params, randomField());
  const turn = envelope(params[1], params[2], commitment);
  const action = { type: 'HOLD' } as const;
  const original = await OFFICIAL_CIRCUIT.expectedPublicSignals(turn, action);
  const uppercase = await OFFICIAL_CIRCUIT.expectedPublicSignals({ ...turn, matchId: turn.matchId.toUpperCase() }, action);
  assert.ok(original.every((word, index) => word === uppercase[index]), 'UUID hex case must not change public signals');
  for (const changed of [{ ...turn, matchId: randomUUID() }, { ...turn, turn: (turn.turn + 1) % 21 }]) {
    const signals = await OFFICIAL_CIRCUIT.expectedPublicSignals(changed, action);
    const binding = await independentPoseidon([BigInt(`0x${changed.matchId.replaceAll('-', '')}`), BigInt(changed.turn), 1n]);
    assert.ok(signals[0] === String(binding) && signals[0] !== original[0], 'binding must follow match and turn changes');
  }
});

test('witness construction rejects a different branch or extraction amount', async () => {
  const params = replaceParam(syntheticParams(), 3, 0n);
  const salt = randomField();
  const commitment = await computeCommitment(OFFICIAL_CIRCUIT, params, salt);
  const turn = envelope(params[1], params[2] + 1n, commitment);
  const mismatches: Action[] = [{ type: 'HOLD' }, { type: 'FORTIFY' },
    { type: 'EXTRACT', amount: Number(params[0] % 10n) + 1 }];
  for (const action of mismatches) {
    expectRejected(() => OFFICIAL_CIRCUIT.buildWitness(turn, action, params, salt));
  }
});

test('commitment, witness, and expected signals reject noncanonical fields before hashing or proving', async () => {
  const params = syntheticParams();
  const salt = randomField();
  const commitment = await computeCommitment(OFFICIAL_CIRCUIT, params, salt);
  const turn = envelope(params[1], params[2], commitment);
  const action = { type: 'HOLD' } as const;
  for (const invalid of [-1n, FIELD_MODULUS, FIELD_MODULUS + 1n]) {
    expectRejected(() => OFFICIAL_CIRCUIT.commitmentInputs(params, invalid));
    expectRejected(() => OFFICIAL_CIRCUIT.buildWitness(turn, action, params, invalid));
    await expectRejectedAsync(() => computeCommitment(OFFICIAL_CIRCUIT, params, invalid));
    for (const balance of ['selfBalance', 'opponentBalance'] as const) {
      const changed = { ...turn, state: { ...turn.state, [balance]: String(invalid) } };
      expectRejected(() => OFFICIAL_CIRCUIT.buildWitness(changed, action, params, salt));
      await expectRejectedAsync(() => OFFICIAL_CIRCUIT.expectedPublicSignals(changed, action));
    }
  }
  const changed = { ...turn, strategyCommitment: { hash: `0x${FIELD_MODULUS.toString(16).padStart(64, '0')}` } };
  expectRejected(() => OFFICIAL_CIRCUIT.buildWitness(changed, action, params, salt));
  await expectRejectedAsync(() => OFFICIAL_CIRCUIT.expectedPublicSignals(changed, action));
});
