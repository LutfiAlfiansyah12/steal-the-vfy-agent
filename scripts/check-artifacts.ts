import { resolve } from 'node:path';
import { zKey } from 'snarkjs';
import { verifyArtifacts } from '../src/proving/artifacts.js';

try {
  const artifacts = await verifyArtifacts(resolve(process.env.ARTIFACT_DIRECTORY ?? 'artifacts'));
  const key = await zKey.exportVerificationKey(artifacts.zkeyPath);
  if (key.protocol !== 'groth16' || key.curve !== 'bn128' || key.nPublic !== 9) throw new Error('unexpected key');
  process.stdout.write('PASS: pinned official WASM/zkey; verification key exports as Groth16/bn128 with 9 public signals. This is not a proof-generation test.\n');
  process.exit(0);
} catch {
  process.stderr.write('Artifact integrity or verification-key export failed.\n');
  process.exit(1);
}
