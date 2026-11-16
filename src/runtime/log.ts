type Event = 'started' | 'not_ready' | 'turn_proven' | 'turn_hold' | 'storage_failed' | 'stopped' | 'startup_failed' | 'proof_started' | 'proof_local_verified' | 'verification_started' | 'verification_finalized';

/** Only fixed event names/codes. Never serialize errors, request bodies, env, or witnesses. */
export function log(event: Event): void {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), event })}\n`);
}
