import { publicInputsHash } from '../protocol/hash.js';
import type { Action, TurnEnvelope, ProofBundle } from '../protocol/schema.js';
import type { Prover } from '../proving/prover.js';
import { validatePublicSignals } from '../proving/prover.js';
import type { CircuitContract, StrategyParams } from '../strategy/contract.js';
import { policy, policyState } from '../strategy/policy.js';
import type { Verifier } from '../verification/kurier.js';
import { TurnFailure, throwIfAborted } from './deadline.js';
import { log } from './log.js';

export interface TurnEvidence {
  action: Action;
  hash: `0x${string}`;
  bundle: ProofBundle;
  proofReference?: string;
}
export interface Engine { execute(envelope: TurnEnvelope, signal: AbortSignal): Promise<TurnEvidence> }

export class ProofEngine implements Engine {
  constructor(
    private readonly contract: CircuitContract,
    private readonly params: StrategyParams,
    private readonly salt: bigint,
    private readonly commitment: `0x${string}`,
    private readonly prover: Prover,
    private readonly verifier?: Verifier,
  ) {}

  async execute(envelope: TurnEnvelope, signal: AbortSignal): Promise<TurnEvidence> {
    throwIfAborted(signal);
    if (this.contract.circuitVersion !== 'v1' || envelope.strategyCommitment.hash.toLowerCase() !== this.commitment.toLowerCase()) throw new TurnFailure('INVALID_PROOF');
    const action = policy(policyState(envelope), this.params, this.contract);
    // Audit hash is eight words; the circuit has NINE public signals. Do not equate them.
    const hash = publicInputsHash(envelope, action);
    const expected = await this.contract.expectedPublicSignals(envelope, action);
    throwIfAborted(signal);
    validatePublicSignals(expected);
    const witness = this.contract.buildWitness(envelope, action, this.params, this.salt);
    log('proof_started');
    const { bundle, verificationKey } = await this.prover.prove(witness, expected, signal);
    log('proof_local_verified');
    throwIfAborted(signal);
    validatePublicSignals(bundle.publicSignals);
    if (bundle.publicSignals.some((value, i) => value !== expected[i])) throw new TurnFailure('INVALID_PROOF');
    if (!this.verifier) return { action, hash, bundle };
    log('verification_started');
    const finalized = await this.verifier.submitAndFinalize(bundle, verificationKey, signal);
    log('verification_finalized');
    throwIfAborted(signal);
    if (!/^0x[0-9a-fA-F]{64}$/.test(finalized.txHash)) throw new TurnFailure('VERIFICATION');
    return { action, hash, bundle, proofReference: finalized.txHash };
  }
}
