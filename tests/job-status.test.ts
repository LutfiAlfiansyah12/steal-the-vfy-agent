import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lookupJob, safeJobId, safeJobState } from '../src/verification/job-status.js';

const key = 'private-test-marker/credential';
const id = 'public-job-123';

test('job metadata allows fixed statuses and safe IDs without exposing API keys', () => {
  assert.equal(safeJobId(id, key), id);
  assert.equal(safeJobId('job-private-test-key', 'private-test-key'), undefined);
  assert.equal(safeJobId('job?token=value', key), undefined);
  assert.equal(safeJobId(key, key), undefined);
  assert.equal(safeJobState('Finalized'), 'Finalized');
  assert.equal(safeJobState(key), 'Unknown');
});

test('lookup performs one GET and returns only safe status metadata', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (input, init) => {
    calls++;
    assert(String(input).includes(`/job-status/${encodeURIComponent(key)}/${id}`));
    assert.equal(init?.method, undefined);
    assert.equal(init?.body, undefined);
    assert.equal(init?.redirect, 'error');
    return new Response(JSON.stringify({ jobId: id, status: 'Finalized',
      createdAt: '2026-11-16T16:37:38.000Z', updatedAt: '2026-11-16T16:38:05.000Z',
      errorDetails: null, message: key, transactionDetails: { secret: key }, proof: key,
    }), { status: 200 });
  };
  const result = await lookupJob(key, id, fetcher);
  assert.equal(calls, 1);
  assert.deepEqual(result, { httpStatus: 200, status: 'Finalized', hasErrorDetails: false,
    createdAt: '2026-11-16T16:37:38.000Z', updatedAt: '2026-11-16T16:38:05.000Z' });
  assert(!JSON.stringify(result).includes(key));
});

test('lookup never returns upstream error text, arbitrary statuses or timestamps', async () => {
  const result = await lookupJob(key, id, async () => new Response(JSON.stringify({
    jobId: id, status: key, createdAt: key, updatedAt: key, errorDetails: { message: key },
  }), { status: 200 }));
  assert.deepEqual(result, { httpStatus: 200, status: 'Unknown', hasErrorDetails: true });
  const unauthorized = await lookupJob(key, id, async () => new Response(key, { status: 401 }));
  assert.deepEqual(unauthorized, { httpStatus: 401 });
});

test('lookup rejects mismatched jobs, missing keys and sensitive fetch exceptions safely', async () => {
  for (const fetcher of [
    async () => new Response(JSON.stringify({ jobId: 'different', status: 'Finalized' }), { status: 200 }),
    async () => { throw new Error(key); },
  ] as typeof fetch[]) {
    await assert.rejects(lookupJob(key, id, fetcher), (error: unknown) => error instanceof Error && !String(error).includes(key));
  }
  let calls = 0;
  await assert.rejects(lookupJob('', id, async () => { calls++; return new Response(); }));
  assert.equal(calls, 0);
});
