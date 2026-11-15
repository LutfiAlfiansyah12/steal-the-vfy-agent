import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { OFFICIAL_CIRCUIT } from '../src/strategy/contract.js';
import { fieldElement, loadPrivateParams } from '../src/strategy/params.js';
import { computeCommitment } from '../src/strategy/commitment.js';
import { policy, policyState } from '../src/strategy/policy.js';
import { turnSchema } from '../src/protocol/schema.js';
import { verifyArtifacts } from '../src/proving/artifacts.js';
import { WorkerProver } from '../src/proving/prover.js';

try {
  const envelopePath = process.argv[2];
  if (!envelopePath) throw new Error('missing envelope');
  const envelope = turnSchema.parse(JSON.parse(await readFile(resolve(envelopePath), 'utf8')));
  const params = loadPrivateParams(process.env);
  const salt = fieldElement(process.env.STRATEGY_SALT);
  const commitment = await computeCommitment(OFFICIAL_CIRCUIT, params, salt);
  if (commitment.toLowerCase() !== envelope.strategyCommitment.hash.toLowerCase()) throw new Error('commitment mismatch');
  const action = policy(policyState(envelope), params, OFFICIAL_CIRCUIT);
  const prover = new WorkerProver(await verifyArtifacts(resolve(process.env.ARTIFACT_DIRECTORY ?? 'artifacts')), 1);
  await prover.prove(OFFICIAL_CIRCUIT.buildWitness(envelope, action, params, salt), await OFFICIAL_CIRCUIT.expectedPublicSignals(envelope, action), AbortSignal.timeout(45_000));
  process.stdout.write('PASS: real local proof verified and all public signals matched. No strategy values or proof data printed; no chain submission.\n');
} catch {
  process.stderr.write('Proof check unavailable or failed. Requires valid private environment, pinned artifacts, and a matching public turn-envelope file.\n');
  process.exitCode = 1;
}
