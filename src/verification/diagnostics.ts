export function logKurier(event: 'submit_started' | 'submit_response' | 'poll_started' | 'poll_response' | 'fetch_failed', status?: number): void {
  const payload = { time: new Date().toISOString(), event: `kurier_${event}`, ...(status === undefined ? {} : { status }) };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}
