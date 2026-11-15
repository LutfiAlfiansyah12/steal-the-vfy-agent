import { OFFICIAL_CIRCUIT } from '../src/strategy/contract.js';
import { computeCommitment } from '../src/strategy/commitment.js';
import { fieldElement, loadPrivateParams } from '../src/strategy/params.js';

try {
  const hash = await computeCommitment(OFFICIAL_CIRCUIT, loadPrivateParams(process.env), fieldElement(process.env.STRATEGY_SALT));
  process.stdout.write(`${hash}\n`);
} catch {
  process.stderr.write('Commitment unavailable: configure valid private parameters and salt in the environment. No values were printed.\n');
  process.exitCode = 1;
}
