import { lookupJob } from '../src/verification/job-status.js';

try {
  const jobId = process.argv[2];
  if (!jobId) throw new Error('missing job ID');
  const summary = await lookupJob(process.env.KURIER_API_KEY ?? '', jobId);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
} catch {
  process.stderr.write('Job lookup failed. Supply the logged job ID and configure the Volta API key privately. No credential or response body was printed.\n');
  process.exitCode = 1;
}
