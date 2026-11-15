import { groth16, zKey } from 'snarkjs';
import type { CircuitInput } from '../strategy/contract.js';
import type { Artifacts } from './artifacts.js';

type Input = Artifacts & { witness: CircuitInput; expectedSignals: readonly string[] };

// A child process, rather than nested worker_threads: snarkjs's web-worker
// dependency needs a main Node thread to export the key and verify the proof.
process.once('message', (input: Input) => {
  void (async () => {
    try {
      const bundle = await groth16.fullProve(input.witness, input.wasmPath, input.zkeyPath, undefined, { memorySize: 256 }, { singleThread: true });
      if (bundle.publicSignals.length !== input.expectedSignals.length || bundle.publicSignals.some((value, i) => value !== input.expectedSignals[i])) throw new Error('signals');
      const verificationKey = await zKey.exportVerificationKey(input.zkeyPath);
      if (verificationKey.protocol !== 'groth16' || verificationKey.curve !== 'bn128' || verificationKey.nPublic !== 9) throw new Error('key');
      if (!await groth16.verify(verificationKey, bundle.publicSignals, bundle.proof)) throw new Error('proof');
      process.send?.({ ok: true, bundle, verificationKey }, () => process.exit(0));
    } catch {
      // snarkjs errors may contain witness data. Send only a fixed failure signal.
      process.send?.({ ok: false }, () => process.exit(1));
    }
  })();
});

// Parent exit/disconnect must not leave a prover or its threads running unattended.
process.on('disconnect', () => process.exit(1));
