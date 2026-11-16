import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { TurnFailure, throwIfAborted } from '../runtime/deadline.js';
import type { ProofBundle } from '../protocol/schema.js';
import { logKurier } from './diagnostics.js';

export const KURIER_TESTNET_URL = 'https://api-testnet.kurier.xyz/api/v1';
export interface FinalizedProof { txHash: string; blockHash?: string; jobId: string }
export interface Verifier {
  submitAndFinalize(bundle: ProofBundle, verificationKey: Record<string, unknown>, signal: AbortSignal): Promise<FinalizedProof>;
}
const jobIdSchema = z.string().min(1).max(256);
const acceptedSchema = z.object({ jobId: jobIdSchema, optimisticVerify: z.enum(['success', 'failed']), error: z.string().nullable().optional() });
const pendingSchema = z.object({ jobId: jobIdSchema, status: z.literal('pending') });
const jobSchema = z.object({
  jobId: jobIdSchema,
  status: z.string(),
  txHash: z.string().nullable().optional(),
  blockHash: z.string().nullable().optional(),
  proofType: z.string().nullable().optional(),
  errorDetails: z.unknown().optional(),
});
const pendingStates = new Set(['Queued', 'Valid', 'Submitted', 'IncludedInBlock']);
const txHashPattern = /^0x[0-9a-fA-F]{64}$/;

export class KurierVerifier implements Verifier {
  constructor(
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly pollIntervalMs = 1000,
  ) {}

  private async request(path: string, signal: AbortSignal, body?: unknown): Promise<Response> {
    throwIfAborted(signal);
    try {
      return await this.fetcher(`${KURIER_TESTNET_URL}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        redirect: 'error',
      });
    } catch {
      // Fetch exceptions may contain the API key in the URL. Never propagate them.
      logKurier('fetch_failed');
      throw new TurnFailure('VERIFICATION');
    }
  }

  async submitAndFinalize(bundle: ProofBundle, verificationKey: Record<string, unknown>, signal: AbortSignal): Promise<FinalizedProof> {
    if (!this.apiKey) throw new TurnFailure('UNAVAILABLE');
    const key = encodeURIComponent(this.apiKey);
    try {
      // No automatic POST retries: the upstream API has no documented idempotency key.
      logKurier('submit_started');
      const response = await this.request(`/submit-proof/${key}`, signal, {
        proofType: 'groth16',
        vkRegistered: false,
        proofOptions: { library: 'snarkjs', curve: 'bn128' },
        proofData: { proof: bundle.proof, publicSignals: bundle.publicSignals, vk: verificationKey },
      });
      let jobId: string;
      logKurier('submit_response', response.status);
      if (response.status === 200) {
        const job = acceptedSchema.parse(await response.json());
        if (job.optimisticVerify !== 'success' || job.error) throw new TurnFailure('VERIFICATION');
        jobId = job.jobId;
      } else if (response.status === 202) {
        jobId = pendingSchema.parse(await response.json()).jobId;
      } else throw new TurnFailure('VERIFICATION');

      while (true) {
        throwIfAborted(signal);
        logKurier('poll_started');
        const statusResponse = await this.request(`/job-status/${key}/${encodeURIComponent(jobId)}`, signal);
        logKurier('poll_response', statusResponse.status);
        if (statusResponse.status !== 200) throw new TurnFailure('VERIFICATION');
        const job = jobSchema.parse(await statusResponse.json());
        if (job.jobId !== jobId || (job.proofType && job.proofType !== 'groth16') || job.errorDetails != null) throw new TurnFailure('VERIFICATION');
        if (job.status === 'Finalized') {
          if (!job.txHash || !txHashPattern.test(job.txHash)) throw new TurnFailure('VERIFICATION');
          if (job.blockHash != null && !txHashPattern.test(job.blockHash)) throw new TurnFailure('VERIFICATION');
          throwIfAborted(signal);
          return { jobId, txHash: job.txHash, ...(job.blockHash ? { blockHash: job.blockHash } : {}) };
        }
        if (!pendingStates.has(job.status)) throw new TurnFailure('VERIFICATION');
        await delay(this.pollIntervalMs, undefined, { signal });
      }
    } catch {
      throw new TurnFailure(signal.aborted ? 'DEADLINE' : 'VERIFICATION');
    }
  }
}
