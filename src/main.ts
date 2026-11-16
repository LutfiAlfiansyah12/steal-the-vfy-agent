import { loadConfig } from './config.js';
import { createAgentServer } from './server.js';
import { verifyArtifacts } from './proving/artifacts.js';
import { WorkerProver } from './proving/prover.js';
import { OFFICIAL_CIRCUIT } from './strategy/contract.js';
import { fieldElement, loadPrivateParams } from './strategy/params.js';
import { computeCommitment } from './strategy/commitment.js';
import { ProofEngine } from './runtime/engine.js';
import { FileTurnStore } from './runtime/store.js';
import { TurnService } from './runtime/turn-service.js';
import { KurierVerifier } from './verification/kurier.js';
import { log } from './runtime/log.js';

try {
  const config = loadConfig();
  const store = new FileTurnStore(config.dataDirectory);
  await store.initialize();
  let engine: ProofEngine | undefined;
  let practiceCommitment: string | undefined;
  try {
    const contract = OFFICIAL_CIRCUIT;
    if (config.proofVerificationMode === 'finalized' && !config.kurierApiKey) throw new Error('not configured');
    const params = loadPrivateParams(process.env);
    const salt = fieldElement(process.env.STRATEGY_SALT);
    const artifacts = await verifyArtifacts(config.artifactDirectory);
    const commitment = await computeCommitment(contract, params, salt);
    const verifier = config.proofVerificationMode === 'finalized' ? new KurierVerifier(config.kurierApiKey) : undefined;
    engine = new ProofEngine(contract, params, salt, commitment, new WorkerProver(artifacts, config.maxConcurrentProofs), verifier);
    practiceCommitment = commitment;
  } catch {
    log('not_ready');
  }
  const service = new TurnService(config, store, engine);
  const server = createAgentServer(config, service, practiceCommitment);
  server.on('error', () => { log('startup_failed'); process.exitCode = 1; });
  server.listen(config.port, config.host, () => log('started'));
  let stopping = false;
  function shutdown(): void {
    if (stopping) return;
    stopping = true;
    service.stop();
    server.close(() => { log('stopped'); });
    server.closeIdleConnections();
    const timer = setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 10_000);
    timer.unref();
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} catch {
  log('startup_failed');
  process.exitCode = 1;
}
