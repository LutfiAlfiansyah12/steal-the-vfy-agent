import assert from 'node:assert/strict';
import { test } from 'node:test';
import { turnSchema } from '../src/protocol/schema.js';
import { commitmentShape, validationSummary } from '../src/protocol/diagnostics.js';

test('commitment diagnostics report representation only, without values', () => {
  assert.equal(commitmentShape({}), 'missing');
  assert.equal(commitmentShape({ strategyCommitment: null }), 'null');
  assert.equal(commitmentShape({ strategyCommitment: 'sensitive-fixture-marker' }), 'string');
  assert.equal(commitmentShape({ strategyCommitment: { hash: 'sensitive-fixture-marker' } }), 'object');
  assert.equal(commitmentShape({ strategyCommitment: [] }), 'array');
  assert.equal(commitmentShape({ strategyCommitment: 42 }), 'other');
});

test('validation diagnostics contain allowed field paths and codes, never received values', () => {
  const marker = 'sensitive-fixture-marker';
  const result = turnSchema.safeParse({
    protocolVersion: marker, eventId: marker, mode: marker, matchId: marker,
    turn: marker, issuedAt: marker, deadlineAt: marker,
    state: { selfBalance: marker, opponentBalance: marker },
    strategyCommitment: { hash: marker }, resolverVersion: marker, nonce: marker,
  });
  assert.equal(result.success, false);
  if (result.success) return;
  const summary = validationSummary(result.error.issues);
  assert(summary.length > 0 && summary.length <= 20);
  assert(summary.some((issue) => issue.field === 'protocolVersion'));
  assert(!JSON.stringify(summary).includes(marker));
  assert(summary.every((issue) => Object.keys(issue).sort().join(',') === 'code,field'));
});
