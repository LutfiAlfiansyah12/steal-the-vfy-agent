import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspect } from 'node:util';
import type { ProofBundle } from '../src/protocol/schema.js';
import { TurnFailure } from '../src/runtime/deadline.js';
import { KURIER_TESTNET_URL, KurierVerifier } from '../src/verification/kurier.js';

const API_KEY = 'public-test-key/with space?and&percent%';
const JOB_ID = 'public-job/7?part=1';
const TX_HASH = `0x${'ab'.repeat(32)}`;
const BLOCK_HASH = `0x${'cd'.repeat(32)}`;
// Transport-only placeholders, deliberately not a circuit witness or a valid proof/VK.
const BUNDLE: ProofBundle = { proof: { mockOnly: 'public-proof-placeholder' }, publicSignals: ['7', '11'] };
const RAW_VK = { mockOnly: 'public-unregistered-vk-placeholder', nested: { preserved: true } };

interface RequestCall {
  url: string;
  init: RequestInit;
}
type FetchStep = Response | ((call: RequestCall) => Response | Promise<Response>);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => { resolve = fulfill; });
  return { promise, resolve };
}

function scriptedFetch(steps: readonly FetchStep[]) {
  const calls: RequestCall[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const call = { url, init: init ?? {} };
    const step = steps[calls.length];
    calls.push(call);
    if (step === undefined) throw new Error('Unexpected extra mocked fetch request');
    return typeof step === 'function' ? step(call) : step;
  };
  return {
    calls,
    fetcher,
    assertConsumed: () => assert.equal(calls.length, steps.length, 'every expected request is made exactly once'),
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function accepted(): Response {
  return json(200, { jobId: JOB_ID, optimisticVerify: 'success', error: null });
}

function finalized(overrides: Record<string, unknown> = {}): Response {
  return json(200, {
    jobId: JOB_ID,
    status: 'Finalized',
    txHash: TX_HASH,
    proofType: 'groth16',
    errorDetails: null,
    ...overrides,
  });
}

function verifyWith(fetcher: typeof fetch, signal = new AbortController().signal) {
  return new KurierVerifier(API_KEY, fetcher, 0).submitAndFinalize(BUNDLE, RAW_VK, signal);
}

async function expectFailure(operation: Promise<unknown>, code: TurnFailure['code'] = 'VERIFICATION'): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof TurnFailure);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    const exposed = `${String(error)}\n${error.stack}\n${inspect(error, { showHidden: true, depth: null })}\n${JSON.stringify(error)}`;
    for (const secret of [API_KEY, encodeURIComponent(API_KEY)]) {
      assert.equal(exposed.includes(secret), false, 'errors, stacks, causes, and properties must not disclose the API key');
    }
    return true;
  });
}

test('200 optimistic success submits the unregistered raw VK and waits for a validated Finalized transaction', async () => {
  const script = scriptedFetch([accepted(), finalized({ blockHash: BLOCK_HASH })]);
  const result = await verifyWith(script.fetcher);
  assert.deepEqual(result, { jobId: JOB_ID, txHash: TX_HASH, blockHash: BLOCK_HASH });
  script.assertConsumed();
  const [submission, poll] = script.calls;
  assert.ok(submission);
  assert.ok(poll);
  assert.equal(submission.url, `${KURIER_TESTNET_URL}/submit-proof/${encodeURIComponent(API_KEY)}`);
  assert.equal(submission.init.method, 'POST');
  assert.ok(typeof submission.init.body === 'string');
  assert.deepEqual(JSON.parse(submission.init.body), {
    proofType: 'groth16',
    vkRegistered: false,
    proofOptions: { library: 'snarkjs', curve: 'bn128' },
    proofData: { proof: BUNDLE.proof, publicSignals: BUNDLE.publicSignals, vk: RAW_VK },
  });
  assert.equal(poll.url, `${KURIER_TESTNET_URL}/job-status/${encodeURIComponent(API_KEY)}/${encodeURIComponent(JOB_ID)}`);
  assert.equal(poll.init.method, 'GET');
  assert.equal(poll.init.body, undefined);
  for (const call of script.calls) {
    assert.equal(call.init.redirect, 'error');
    assert.ok(call.init.signal instanceof AbortSignal);
    assert.equal(call.init.signal.aborted, false);
    const headers = new Headers(call.init.headers);
    assert.equal(headers.get('content-type'), 'application/json');
    assert.equal(headers.get('accept'), 'application/json');
  }
});

test('202 pending is accepted and polled; optional blockHash may be absent or null', async () => {
  for (const overrides of [{}, { blockHash: null }]) {
    const script = scriptedFetch([json(202, { jobId: JOB_ID, status: 'pending' }), finalized(overrides)]);
    assert.deepEqual(await verifyWith(script.fetcher), { jobId: JOB_ID, txHash: TX_HASH });
    script.assertConsumed();
    assert.equal(script.calls[1]?.init.method, 'GET');
  }
});

test('Queued, Valid, Submitted, and IncludedInBlock remain pending until Finalized, even with a txHash', { timeout: 3000 }, async () => {
  const finalPollStarted = deferred<void>();
  const finalResponse = deferred<Response>();
  const script = scriptedFetch([
    accepted(),
    ...['Queued', 'Valid', 'Submitted', 'IncludedInBlock'].map((status) => json(200, {
      jobId: JOB_ID, status, txHash: TX_HASH, blockHash: BLOCK_HASH,
    })),
    () => {
      finalPollStarted.resolve();
      return finalResponse.promise;
    },
  ]);
  let settled = false;
  const operation = verifyWith(script.fetcher);
  void operation.then(() => { settled = true; }, () => { settled = true; });
  try {
    await Promise.race([
      finalPollStarted.promise,
      operation.then(() => assert.fail('a nonfinalized status completed verification')),
    ]);
    assert.equal(settled, false, 'IncludedInBlock with a transaction hash is still not finality');
    assert.equal(script.calls.length, 6);
  } finally {
    finalResponse.resolve(finalized({ blockHash: BLOCK_HASH }));
  }
  assert.deepEqual(await operation, { jobId: JOB_ID, txHash: TX_HASH, blockHash: BLOCK_HASH });
  script.assertConsumed();
});

test('Finalized accepts uppercase hex digits in an otherwise well-formed transaction hash', async () => {
  const txHash = `0x${'AB'.repeat(32)}`;
  const script = scriptedFetch([accepted(), finalized({ txHash })]);
  assert.deepEqual(await verifyWith(script.fetcher), { jobId: JOB_ID, txHash });
  script.assertConsumed();
});

const rejectedSubmissions: ReadonlyArray<readonly [string, number, unknown]> = [
  ['optimistic failed', 200, { jobId: JOB_ID, optimisticVerify: 'failed' }],
  ['optimistic failed with an API-key-bearing error', 200, { jobId: JOB_ID, optimisticVerify: 'failed', error: API_KEY }],
  ['optimistic success with a contradictory error', 200, { jobId: JOB_ID, optimisticVerify: 'success', error: API_KEY }],
  ['missing optimistic result', 200, { jobId: JOB_ID }],
  ['unknown optimistic result', 200, { jobId: JOB_ID, optimisticVerify: 'pending' }],
  ['empty jobId', 200, { jobId: '', optimisticVerify: 'success' }],
  ['missing jobId', 200, { optimisticVerify: 'success' }],
  ['oversized jobId', 200, { jobId: API_KEY.repeat(20), optimisticVerify: 'success' }],
  ['202 with the wrong status', 202, { jobId: JOB_ID, status: 'Finalized', txHash: TX_HASH }],
  ['202 with missing status', 202, { jobId: JOB_ID }],
  ['202 with a nonstring jobId', 202, { jobId: 7, status: 'pending' }],
  ['unexpected 201 response', 201, { jobId: JOB_ID, optimisticVerify: 'success' }],
  ['rate limit response', 429, { error: API_KEY }],
  ['server error response', 500, { error: encodeURIComponent(API_KEY) }],
];
for (const [label, status, body] of rejectedSubmissions) {
  test(`rejects submission ${label} without polling or retrying POST`, async () => {
    const script = scriptedFetch([json(status, body)]);
    await expectFailure(verifyWith(script.fetcher));
    script.assertConsumed();
  });
}

const rejectedJobs: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ['Failed', { status: 'Failed' }],
  ['unknown status', { status: 'UnexpectedStatus' }],
  ['wrong status case', { status: 'finalized' }],
  ['submission pending status on a job', { status: 'pending' }],
  ['wrong jobId', { jobId: 'different-public-job' }],
  ['missing jobId', { jobId: undefined }],
  ['wrong proof type', { proofType: 'plonk' }],
  ['Finalized with contradictory errorDetails', { errorDetails: { message: API_KEY } }],
  ['IncludedInBlock with errorDetails', { status: 'IncludedInBlock', errorDetails: API_KEY }],
  ['Finalized with empty errorDetails', { errorDetails: '' }],
  ['Finalized with false errorDetails', { errorDetails: false }],
  ['malformed block hash', { blockHash: '0x1234' }],
];
for (const [label, overrides] of rejectedJobs) {
  test(`rejects ${label} even when the job carries a valid transaction hash`, async () => {
    const script = scriptedFetch([accepted(), finalized(overrides)]);
    await expectFailure(verifyWith(script.fetcher));
    script.assertConsumed();
  });
}

const rejectedHashes: ReadonlyArray<readonly [string, unknown]> = [
  ['missing', undefined],
  ['null', null],
  ['empty', ''],
  ['short', `0x${'ab'.repeat(31)}`],
  ['long', `0x${'ab'.repeat(33)}`],
  ['unprefixed', 'ab'.repeat(32)],
  ['wrong prefix', `0X${'ab'.repeat(32)}`],
  ['nonhex', `0x${'ab'.repeat(31)}gg`],
  ['leading whitespace', ` ${TX_HASH}`],
  ['trailing whitespace', `${TX_HASH} `],
  ['trailing newline', `${TX_HASH}\n`],
  ['nonstring', 7],
];
for (const [label, txHash] of rejectedHashes) {
  test(`Finalized rejects a ${label} transaction hash`, async () => {
    const script = scriptedFetch([accepted(), finalized({ txHash })]);
    await expectFailure(verifyWith(script.fetcher));
    script.assertConsumed();
  });
}

test('a nonfinalized transaction hash cannot mask a later Failed status', async () => {
  const script = scriptedFetch([
    accepted(),
    json(200, { jobId: JOB_ID, status: 'IncludedInBlock', txHash: TX_HASH }),
    json(200, { jobId: JOB_ID, status: 'Failed', txHash: TX_HASH }),
  ]);
  await expectFailure(verifyWith(script.fetcher));
  script.assertConsumed();
});

test('a job-status response must be HTTP 200 even if its body says Finalized', async () => {
  const script = scriptedFetch([accepted(), json(202, { jobId: JOB_ID, status: 'Finalized', txHash: TX_HASH })]);
  await expectFailure(verifyWith(script.fetcher));
  script.assertConsumed();
});

for (const stage of ['submission', 'poll'] as const) {
  test(`${stage} refuses redirects and never requests the Location target`, async () => {
    const redirect = new Response(JSON.stringify({ jobId: JOB_ID, optimisticVerify: 'success', status: 'Finalized', txHash: TX_HASH }), {
      status: 307,
      headers: { location: 'https://untrusted.example.invalid/collect' },
    });
    const script = scriptedFetch(stage === 'submission' ? [redirect] : [accepted(), redirect]);
    await expectFailure(verifyWith(script.fetcher));
    script.assertConsumed();
    for (const call of script.calls) {
      assert.equal(call.init.redirect, 'error');
      assert.equal(new URL(call.url).origin, new URL(KURIER_TESTNET_URL).origin);
    }
  });

  test(`${stage} sanitizes fetch errors containing both raw and URL-encoded API keys`, async () => {
    const failedFetch: FetchStep = (call) => {
      assert.equal(call.init.redirect, 'error');
      throw new TypeError(`redirect refused: ${call.url}; key=${API_KEY}`, { cause: new Error(encodeURIComponent(API_KEY)) });
    };
    const script = scriptedFetch(stage === 'submission' ? [failedFetch] : [accepted(), failedFetch]);
    await expectFailure(verifyWith(script.fetcher));
    script.assertConsumed();
  });

  test(`${stage} sanitizes JSON parsing failures without retrying`, async () => {
    const malformed = new Response(`invalid JSON ${API_KEY} ${encodeURIComponent(API_KEY)}`, { status: 200 });
    const script = scriptedFetch(stage === 'submission' ? [malformed] : [accepted(), malformed]);
    await expectFailure(verifyWith(script.fetcher));
    script.assertConsumed();
  });

  test(`${stage} sanitizes a rejected response body containing the API key`, async () => {
    const brokenBody = json(200, {});
    brokenBody.json = async () => { throw new Error(`body read failed ${API_KEY} ${encodeURIComponent(API_KEY)}`); };
    const script = scriptedFetch(stage === 'submission' ? [brokenBody] : [accepted(), brokenBody]);
    await expectFailure(verifyWith(script.fetcher));
    script.assertConsumed();
  });
}

test('an already-aborted signal makes no network request and exposes no abort reason', async () => {
  const controller = new AbortController();
  controller.abort(new Error(API_KEY));
  const script = scriptedFetch([]);
  await expectFailure(verifyWith(script.fetcher, controller.signal), 'DEADLINE');
  script.assertConsumed();
});

test('abort interrupts the polling delay immediately instead of waiting for another request', { timeout: 2000 }, async (t) => {
  const controller = new AbortController();
  t.after(() => controller.abort());
  const pendingRead = deferred<void>();
  const pending = json(200, {});
  pending.json = async () => {
    // Let the continuation enter its long polling delay before notifying the test.
    setImmediate(() => pendingRead.resolve());
    return { jobId: JOB_ID, status: 'IncludedInBlock', txHash: TX_HASH };
  };
  const script = scriptedFetch([accepted(), pending]);
  const operation = new KurierVerifier(API_KEY, script.fetcher, 60_000).submitAndFinalize(BUNDLE, RAW_VK, controller.signal);
  const failure = expectFailure(operation, 'DEADLINE');
  await Promise.race([
    pendingRead.promise,
    failure.then(() => assert.fail('verification stopped before the caller aborted')),
  ]);
  controller.abort(new Error(`cancelled ${API_KEY}`));
  await failure;
  script.assertConsumed();
  for (const call of script.calls) assert.equal(call.init.signal?.aborted, true);
});

test('abort reaches an in-flight mocked fetch and its sensitive failure is sanitized', { timeout: 2000 }, async (t) => {
  const controller = new AbortController();
  t.after(() => controller.abort());
  const started = deferred<AbortSignal>();
  const script = scriptedFetch([(call) => {
    assert.ok(call.init.signal instanceof AbortSignal);
    const signal = call.init.signal;
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error(`aborted fetch ${call.url} ${API_KEY}`)), { once: true });
      started.resolve(signal);
    });
  }]);
  const failure = expectFailure(verifyWith(script.fetcher, controller.signal), 'DEADLINE');
  const requestSignal = await started.promise;
  assert.equal(requestSignal.aborted, false);
  controller.abort(new Error(API_KEY));
  await failure;
  assert.equal(requestSignal.aborted, true);
  script.assertConsumed();
});

test('abort after reading Finalized prevents returning a transaction after the deadline', async () => {
  const controller = new AbortController();
  const finalResponse = json(200, {});
  finalResponse.json = async () => {
    controller.abort(new Error(API_KEY));
    return { jobId: JOB_ID, status: 'Finalized', txHash: TX_HASH };
  };
  const script = scriptedFetch([accepted(), finalResponse]);
  await expectFailure(verifyWith(script.fetcher, controller.signal), 'DEADLINE');
  script.assertConsumed();
});

test('a missing API key reports UNAVAILABLE without calling fetch', async () => {
  const script = scriptedFetch([]);
  const verifier = new KurierVerifier('', script.fetcher, 0);
  await expectFailure(verifier.submitAndFinalize(BUNDLE, RAW_VK, new AbortController().signal), 'UNAVAILABLE');
  script.assertConsumed();
});
