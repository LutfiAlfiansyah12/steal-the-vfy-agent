import { fork, type ChildProcess } from 'node:child_process';
import { TurnFailure, throwIfAborted } from '../runtime/deadline.js';
import { FIELD_MODULUS, type ProofBundle } from '../protocol/schema.js';
import type { CircuitInput } from '../strategy/contract.js';
import type { Artifacts } from './artifacts.js';

export interface Proven { bundle: ProofBundle; verificationKey: Record<string, unknown> }
export interface Prover {
  prove(witness: CircuitInput, expectedSignals: readonly string[], signal: AbortSignal): Promise<Proven>;
}

export function validatePublicSignals(signals: readonly string[]): void {
  if (signals.length !== 9 || signals.some((s) => !/^(0|[1-9][0-9]{0,77})$/.test(s) || BigInt(s) >= FIELD_MODULUS)) throw new TurnFailure('INVALID_PROOF');
}

/** CPU-heavy snarkjs runs in an isolated process; abort kills it and all its worker threads. */
export class WorkerProver implements Prover {
  private active = 0;
  constructor(private readonly artifacts: Artifacts, private readonly limit: number) {}

  async prove(witness: CircuitInput, expectedSignals: readonly string[], signal: AbortSignal): Promise<Proven> {
    throwIfAborted(signal);
    validatePublicSignals(expectedSignals);
    if (this.active >= this.limit) throw new TurnFailure('UNAVAILABLE');
    this.active++;
    let child: ChildProcess | undefined;
    try {
      return await new Promise<Proven>((resolve, reject) => {
        child = fork(new URL('./worker.js', import.meta.url), [], {
          // No secrets in command line/env or diagnostic pipes; witness travels over IPC only.
          execArgv: ['--max-old-space-size=512', '--disable-proto=throw'],
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          env: process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {},
          windowsHide: true,
        });
        let settled = false;
        const done = (result?: Proven): void => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', abort);
          if (result) resolve(result);
          else reject(new TurnFailure(signal.aborted ? 'DEADLINE' : 'INVALID_PROOF'));
        };
        const abort = (): void => { done(); };
        signal.addEventListener('abort', abort, { once: true });
        child.once('error', () => done());
        child.once('exit', () => done());
        child.once('message', (message: { ok?: boolean; bundle?: ProofBundle; verificationKey?: Record<string, unknown> }) => {
          if (!signal.aborted && message?.ok && message.bundle && message.verificationKey) done({ bundle: message.bundle, verificationKey: message.verificationKey });
          else done();
        });
        child.send({ ...this.artifacts, witness, expectedSignals }, (error) => { if (error) done(); });
        if (signal.aborted) abort();
      });
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 1000);
          timer.unref();
          const done = (): void => { clearTimeout(timer); resolve(); };
          child!.once('exit', done);
          child!.once('error', done);
          child!.kill('SIGKILL');
        });
      }
      this.active--;
    }
  }
}
