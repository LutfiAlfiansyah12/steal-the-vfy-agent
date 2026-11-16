export const KURIER_TESTNET_BASE = 'https://api-testnet.kurier.xyz/api/v1';
const states = new Set(['Queued', 'Valid', 'Submitted', 'IncludedInBlock', 'Finalized', 'Failed', 'AggregationPending', 'Aggregated', 'AggregationPublished']);

export function safeJobId(value: string, apiKey: string): string | undefined {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) return undefined;
  if (apiKey && (value.includes(apiKey) || value.includes(encodeURIComponent(apiKey)))) return undefined;
  return value;
}

export function safeJobState(value: unknown): string {
  return typeof value === 'string' && states.has(value) ? value : 'Unknown';
}

export interface JobStatusSummary {
  httpStatus: number;
  status?: string;
  hasErrorDetails?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/** A single GET: never resubmit a proof, and never return upstream bodies/errors. */
export async function lookupJob(apiKey: string, jobId: string, fetcher: typeof fetch = fetch): Promise<JobStatusSummary> {
  if (!apiKey || !safeJobId(jobId, apiKey)) throw new Error('Job lookup configuration invalid');
  try {
    const response = await fetcher(`${KURIER_TESTNET_BASE}/job-status/${encodeURIComponent(apiKey)}/${encodeURIComponent(jobId)}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    });
    if (response.status !== 200) return { httpStatus: response.status };
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || !('jobId' in body) || body.jobId !== jobId || !('status' in body)) throw new Error('invalid response');
    const result: JobStatusSummary = {
      httpStatus: 200,
      status: safeJobState(body.status),
      hasErrorDetails: 'errorDetails' in body && body.errorDetails != null,
    };
    for (const key of ['createdAt', 'updatedAt'] as const) {
      const value = (body as Record<string, unknown>)[key];
      if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
        && Number.isFinite(Date.parse(value)) && !value.includes(apiKey)) result[key] = value;
    }
    return result;
  } catch {
    throw new Error('Job lookup failed or timed out');
  }
}
