import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { test } from 'node:test';
import { keccak256 } from 'viem';
import { SIGNATURE_HEADER, sign, verifySignature } from '../src/protocol/hmac.js';
import { publicInputsHash, publicInputsWords } from '../src/protocol/hash.js';
import { actionAmount, actionCode, actionSchema, turnSchema, type Action, type TurnEnvelope } from '../src/protocol/schema.js';

// Arbitrary public protocol data, with balances above Number.MAX_SAFE_INTEGER.
// No strategy parameters, circuit witness, or claim of a valid proof is involved.
const PUBLIC_TURN = {
  protocolVersion: 'v1',
  eventId: 'steal-the-vfy',
  mode: 'practice',
  matchId: '00112233-4455-6677-8899-aabbccddeeff',
  turn: 7,
  issuedAt: '2026-11-15T12:00:00.000Z',
  deadlineAt: '2026-11-15T12:00:30.000Z',
  state: {
    selfBalance: '1208925819614629174706179',
    opponentBalance: '18446744073709551633',
    selfFortifiedUntilTurn: null,
    opponentFortifiedUntilTurn: 9,
  },
  strategyCommitment: { hash: '0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f' },
  resolverVersion: 'v1',
  nonce: 'public-fixture-é',
} satisfies TurnEnvelope;
const HMAC_SECRET = 'public-test-only-hmac-secret';

// Literal words in the /build order: commitment, UUID as a number, turn,
// selfBalance, opponentBalance, actionCode, amount, 1.
const PUBLIC_WORDS_PREFIX = [
  0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1fn,
  0x00112233445566778899aabbccddeeffn,
  7n,
  1208925819614629174706179n,
  18446744073709551633n,
] as const;

function encodeWordsBE(words: readonly bigint[]): Buffer {
  return Buffer.from(words.map((word) => word.toString(16).padStart(64, '0')).join(''), 'hex');
}

const HASH_VECTORS: ReadonlyArray<{ action: Action; code: bigint; amount: bigint; hash: string }> = [
  { action: { type: 'HOLD' }, code: 0n, amount: 0n, hash: '0xc70089641fdda6ee20f2fa48da4521296998b06f22a5dde7ffb776eb9650060d' },
  { action: { type: 'FORTIFY' }, code: 1n, amount: 0n, hash: '0xcf06dadc5d723991c8c9ba8836580f0d2e5a20ca094a8aa71172728d0f69b3d6' },
  { action: { type: 'EXTRACT', amount: 6 }, code: 2n, amount: 6n, hash: '0x3e05f84d03c6e29b13455925272aba6b51510fa9c3a28f0018fc78ade434e5dd' },
];

test('HMAC-SHA256 matches an independent standard vector and the protocol header name', () => {
  const expected = 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7';
  const secret = '\x0b'.repeat(20);
  assert.equal(SIGNATURE_HEADER, 'x-agent-games-signature');
  assert.equal(sign('Hi There', secret), expected);
  assert.equal(sign(Buffer.from('Hi There'), secret), expected);
  assert.equal(verifySignature(Buffer.from('Hi There'), expected, secret), true);
  assert.equal(verifySignature(Buffer.from('Hi There'), expected.toUpperCase(), secret), true);
  assert.equal(verifySignature(Buffer.from('Hi There'), expected, 'different-public-secret'), false);
});

test('authenticates original bytes before JSON parsing; whitespace changes require a new digest', () => {
  const raw = Buffer.from(` \r\n${JSON.stringify(PUBLIC_TURN, null, 2)}\t\n`, 'utf8');
  const digest = createHmac('sha256', HMAC_SECRET).update(raw).digest('hex');
  assert.equal(sign(raw, HMAC_SECRET), digest);
  assert.equal(verifySignature(raw, digest, HMAC_SECRET), true);

  const parsed = turnSchema.parse(JSON.parse(raw.toString('utf8')));
  assert.deepEqual(parsed, PUBLIC_TURN);
  const compact = Buffer.from(JSON.stringify(parsed), 'utf8');
  assert.deepEqual(JSON.parse(compact.toString('utf8')), parsed);
  assert.notDeepEqual(raw, compact);
  assert.notEqual(sign(compact, HMAC_SECRET), digest);
  assert.equal(verifySignature(compact, digest, HMAC_SECRET), false);
  assert.equal(verifySignature(compact, sign(compact, HMAC_SECRET), HMAC_SECRET), true);
  assert.equal(verifySignature(raw, sign(compact, HMAC_SECRET), HMAC_SECRET), false);

  const changedWhitespace = Buffer.from(raw);
  changedWhitespace[0] = 0x09;
  assert.deepEqual(JSON.parse(changedWhitespace.toString('utf8')), parsed);
  assert.notEqual(sign(changedWhitespace, HMAC_SECRET), digest);
  assert.equal(verifySignature(changedWhitespace, digest, HMAC_SECRET), false);
});

test('HMAC does not decode distinct raw byte sequences into the same UTF-8 text', () => {
  const first = Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]);
  const second = Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xfe, 0x22, 0x7d]);
  assert.equal(Buffer.from(first).toString('utf8'), Buffer.from(second).toString('utf8'));
  const digest = createHmac('sha256', HMAC_SECRET).update(first).digest('hex');
  assert.equal(verifySignature(first, digest, HMAC_SECRET), true);
  assert.notEqual(sign(second, HMAC_SECRET), digest);
  assert.equal(verifySignature(second, digest, HMAC_SECRET), false);
});

const validHeader = createHmac('sha256', HMAC_SECRET).update('public-body').digest('hex');
const invalidHeaders: ReadonlyArray<readonly [string, string | undefined]> = [
  ['missing', undefined],
  ['empty', ''],
  ['too short', validHeader.slice(1)],
  ['too long', `${validHeader}0`],
  ['sha256 prefix', `sha256=${validHeader}`],
  ['0x prefix', `0x${validHeader}`],
  ['nonhex at the start', `g${validHeader.slice(1)}`],
  ['nonhex at the end', `${validHeader.slice(0, -1)}z`],
  ['leading whitespace', ` ${validHeader}`],
  ['trailing whitespace', `${validHeader} `],
  ['trailing newline', `${validHeader}\n`],
  ['embedded separator', `${validHeader.slice(0, 32)}:${validHeader.slice(33)}`],
];
for (const [label, header] of invalidHeaders) {
  test(`signature rejects ${label} without throwing on invalid buffer length`, () => {
    assert.equal(verifySignature(Buffer.from('public-body'), header, HMAC_SECRET), false);
  });
}

test('signature rejects a different well-formed 32-byte digest', () => {
  assert.equal(verifySignature(Buffer.from('public-body'), '00'.repeat(32), HMAC_SECRET), false);
});

for (const vector of HASH_VECTORS) {
  test(`${vector.action.type} publicInputsHash matches all eight numeric words and a fixed Keccak vector`, () => {
    const envelope = turnSchema.parse(PUBLIC_TURN);
    const action = actionSchema.parse(vector.action);
    const expectedWords = [...PUBLIC_WORDS_PREFIX, vector.code, vector.amount, 1n];
    assert.deepEqual(publicInputsWords(envelope, action), expectedWords);
    assert.equal(publicInputsWords(envelope, action).length, 8);
    assert.equal(actionCode(action), vector.code);
    assert.equal(actionAmount(action), vector.amount);

    const bytes = encodeWordsBE(expectedWords);
    assert.equal(bytes.length, 8 * 32);
    assert.equal(bytes.subarray(0, 32).toString('hex'), PUBLIC_TURN.strategyCommitment.hash.slice(2));
    assert.deepEqual(bytes.subarray(32, 64), Buffer.concat([
      Buffer.alloc(16), Buffer.from('00112233445566778899aabbccddeeff', 'hex'),
    ]));
    assert.equal(bytes.subarray(64, 96).toString('hex'), `${'00'.repeat(31)}07`);
    assert.equal(bytes.subarray(224, 256).toString('hex'), `${'00'.repeat(31)}01`);
    assert.equal(keccak256(bytes), vector.hash);
    assert.equal(publicInputsHash(envelope, action), vector.hash);
  });
}

test('publicInputsHash distinguishes SHA3, wrong order, little endian, compact words, and a changed final word', () => {
  const words = [...PUBLIC_WORDS_PREFIX, 2n, 6n, 1n] as const;
  const bytes = encodeWordsBE(words);
  const actual = publicInputsHash(PUBLIC_TURN, { type: 'EXTRACT', amount: 6 });
  assert.notEqual(actual, `0x${createHash('sha3-256').update(bytes).digest('hex')}`);

  const swappedBalances = [words[0], words[1], words[2], words[4], words[3], words[5], words[6], words[7]];
  assert.notEqual(actual, keccak256(encodeWordsBE(swappedBalances)));
  const littleEndian = Buffer.concat(words.map((word) => encodeWordsBE([word]).reverse()));
  assert.notEqual(actual, keccak256(littleEndian));
  const compact = Buffer.concat(words.map((word) => {
    const hex = word.toString(16);
    return Buffer.from(hex.length % 2 === 0 ? hex : `0${hex}`, 'hex');
  }));
  assert.ok(compact.length < 256);
  assert.notEqual(actual, keccak256(compact));
  assert.notEqual(actual, keccak256(encodeWordsBE(words.slice(0, 7))));
  assert.notEqual(actual, keccak256(encodeWordsBE([...words.slice(0, 7), 0n])));
});

test('commitment and UUID are encoded numerically, independent of their hexadecimal letter case', () => {
  const upperCase = turnSchema.parse({
    ...PUBLIC_TURN,
    matchId: PUBLIC_TURN.matchId.toUpperCase(),
    strategyCommitment: { hash: `0x${PUBLIC_TURN.strategyCommitment.hash.slice(2).toUpperCase()}` },
  });
  assert.deepEqual(publicInputsWords(upperCase, { type: 'HOLD' }), [...PUBLIC_WORDS_PREFIX, 0n, 0n, 1n]);
  assert.equal(publicInputsHash(upperCase, { type: 'HOLD' }), publicInputsHash(PUBLIC_TURN, { type: 'HOLD' }));
});

for (const type of ['HOLD', 'FORTIFY'] as const) {
  test(`${type} omits amount on the wire and rejects any supplied amount property`, () => {
    const action = actionSchema.parse({ type });
    assert.deepEqual(action, { type });
    assert.equal(Object.hasOwn(action, 'amount'), false);
    assert.equal(actionAmount(action), 0n);
    for (const amount of [0, 1, 10, null, undefined, '0']) {
      assert.equal(actionSchema.safeParse({ type, amount }).success, false);
    }
  });
}

test('EXTRACT accepts exactly integer amounts 1 through 10', () => {
  for (let amount = 1; amount <= 10; amount += 1) {
    const action = actionSchema.parse({ type: 'EXTRACT', amount });
    assert.deepEqual(action, { type: 'EXTRACT', amount });
    assert.equal(actionCode(action), 2n);
    assert.equal(actionAmount(action), BigInt(amount));
  }
  assert.equal(actionSchema.safeParse({ type: 'EXTRACT' }).success, false);
  for (const amount of [undefined, null, -1, 0, 11, 1.5, 9.999, NaN, Infinity, -Infinity, '1', 1n, true]) {
    assert.equal(actionSchema.safeParse({ type: 'EXTRACT', amount }).success, false, `rejected amount ${String(amount)}`);
  }
});

test('action schema rejects unknown types and extra action properties', () => {
  for (const action of [{}, { type: 'hold' }, { type: 'STEAL', amount: 1 }, { type: 'EXTRACT', amount: 1, extra: true }]) {
    assert.equal(actionSchema.safeParse(action).success, false);
  }
});
