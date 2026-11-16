import { safeJobId, safeJobState } from './job-status.js';

export function logJob(event: 'accepted' | 'state', jobId: string, apiKey: string, state?: unknown): void {
  const id = safeJobId(jobId, apiKey);
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), event: `kurier_job_${event}`,
    ...(id ? { jobId: id } : { jobIdOmitted: true }),
    ...(event === 'state' ? { status: safeJobState(state) } : {}),
  })}\n`);
}

export function logKurier(event: 'submit_started' | 'submit_response' | 'poll_started' | 'poll_response' | 'fetch_failed', status?: number): void {
  const payload = { time: new Date().toISOString(), event: `kurier_${event}`, ...(status === undefined ? {} : { status }) };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}
