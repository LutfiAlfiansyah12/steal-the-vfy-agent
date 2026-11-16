# Protocol evidence and interoperability notes

Updated 2026-11-17 for the user-approved local proof response mode. Sources:

- https://agentgames.zkverify.io/build (Steal the VFY, artifacts, preflight, common mistakes)
- https://agentgames.zkverify.io/guide (registration and HMAC encoding)
- https://agentgames.zkverify.io/events/steal-the-vfy (event-specific schedule/scoring/deadline)
- https://agentgames.zkverify.io/api/circuit-info (artifact links and mainnet vk_hash)
- https://docs.zkverify.io/overview/getting-started/kurier
- https://api-testnet.kurier.xyz/docs/json (live Swagger v1.36.0)

The full circuit adapter is now implemented. [CIRCUIT.md](CIRCUIT.md) distinguishes artifact-derived, cryptographically tested semantics from organizer-published prose. Source `.circom` was not found; it is no longer treated as a prerequisite because the official binary contract was recovered and tested directly.

## Transport

The guide shows `x-agent-games-signature: <hmac-sha256-hex>`. The build page requires HMAC over RAW request and response bodies. The service uses the dashboard plaintext secret as UTF-8, accepts 64 hex characters in either case, emits lowercase hex and compares decoded digests in constant time. It does not use `sha256=`/`0x` prefixes, base64, canonical JSON or hex-decoded secret bytes. Secret-byte encoding lacks a published test vector; confirm through signed platform preflight.

Preflight request: `type: "agent-games.preflight.v1"`, `agent_id`, `issued_at`, `nonce`. Signed response: `{"ok":true,"protocolVersion":"v1"}`. `/readyz` separately reports initialized proof configuration.

Turn: `protocolVersion:"v1"`, `eventId:"steal-the-vfy"`, `mode`, `matchId`, `turn`, `issuedAt`, `deadlineAt`, `state` with decimal-string balances and nullable fortification turns, `strategyCommitment.hash`, `resolverVersion:"v1"`, `nonce`.

Successful response echoes `matchId` and `turn` and includes `action`, `policyProof:{circuitVersion,publicInputsHash,proof,public_signals}`, `agentTimestamp`, and `idempotencyKey`. The current official `/build` VFY instructions explicitly describe offline verification and require `circuitVersion`, with `proof` and `public_signals` INSIDE `policyProof`. An onchain `proofReference` is an optional audit pointer only. Local mode omits that property entirely; finalized mode adds the validated Kurier transaction hash. The service still computes and includes `publicInputsHash` in both modes. HOLD/FORTIFY never include `action.amount`; their internal circuit/audit amount is zero.

The input parser additionally accepts an explicitly supplied bare 32-byte hash string in `strategyCommitment` and normalizes it to `{hash}` after HMAC verification. This is a compatibility extension, not evidence that the official competition example changed.

Authenticated practice requests observed on 2026-11-16 omit `strategyCommitment` entirely. For `protocolVersion:v1`, `eventId:steal-the-vfy`, `mode:practice` only, an absent field is filled with the commitment already computed from the locally validated parameters/salt and pinned artifacts during proof-engine initialization. This makes the local practice proof self-consistent; it does not assert what the platform has registered/frozen. All other fields, freshness, proof generation, expected public signals and local Groth16 verification remain mandatory. A supplied hash is never overwritten, and explicit null/invalid values remain rejected. Competition requests always require an explicit matching platform commitment, with no fallback. If local proof configuration is unavailable, an absent commitment is still rejected. Live platform acceptance remains to be confirmed.

Diagnostic logs report only allowed field paths, error codes and commitment representation (string/object/null/missing), never received values. Proof fallback logs expose only a fixed failure class (`INVALID_PROOF`, `VERIFICATION`, `DEADLINE`, etc.); proof-stage logs contain only fixed events (`proof_started`, `proof_local_verified`, `verification_started`, `verification_finalized`).

## Proof response modes

`PROOF_VERIFICATION_MODE` accepts `local` or `finalized` and defaults to `local`. The user approved returning the locally verified proof without waiting for Kurier, following the current `/build` offline-verification contract. This changes the original frozen requirement to wait for onchain finality; local verification does not imply Finalized status or meet that original requirement.

In both modes the adapter derives the committed policy action, builds the witness against pinned official artifacts, independently checks all nine expected public signals, verifies Groth16 against the pinned key, computes the exact audit hash, and signs the exact response bytes with HMAC. Commitment validation, field ranges, deadlines, durable replay and failure handling remain strict.

Local mode makes no Kurier submission, requires no `KURIER_API_KEY`, and omits `policyProof.proofReference` entirely rather than sending a null or fabricated value. An already configured key can remain unused. Readiness still requires valid HMAC startup configuration, parameters, salt and pinned artifact/proof-engine initialization. Finalized mode additionally requires the Volta Kurier key and retains `waitFinalized` behavior before adding a validated transaction reference. The mode does not enable competition: `ALLOW_COMPETITION` remains false by default and explicitly false in Compose until practice is accepted.

## Exact audit hash

Use Keccak-256, not SHA3-256, over eight concatenated unsigned 32-byte big-endian words:

1. strategy commitment interpreted as integer
2. match UUID with hyphens removed, interpreted as hex integer
3. turn
4. self balance
5. opponent balance
6. action code HOLD=0, FORTIFY=1, EXTRACT=2
7. EXTRACT amount, otherwise zero
8. circuit version v1=1

Do not reduce these words modulo the scalar field, add fortification/history/nonce/timestamps, or substitute a Poseidon output. The adapter independently validates canonical field inputs before proving, so it never makes the proof describe a silently reduced state. The circuit has nine public signals: a Poseidon match/turn/version binding followed by these eight values. See [CIRCUIT.md](CIRCUIT.md).

## Local failure controls and site inconsistencies

The current build instructions treat onchain `proofReference` as an optional audit pointer; common mistakes warns that omitting `publicInputsHash` causes rejection. Successful responses therefore always include the computed `publicInputsHash`, while only finalized mode includes `proofReference`. Failed proofs/configuration return HOLD plus its correct audit hash without invented `proof`, `public_signals` or `proofReference`. The committed policy can demand a different action, so there is no general way to produce a valid emergency HOLD proof. The event page describes invalid proofs as a −2 turn penalty and timeout as −1; confirm actual fallback classification in practice.

The general build/guide says 60-second response deadline. The event page says 5 minutes per turn and approximately 30 seconds per push. The service respects the earlier envelope deadline and `MAX_TURN_MS` (default 25 seconds), subtracting `RESPONSE_RESERVE_MS` (1500 ms) for storage/response. An observed practice envelope left about 14.75 seconds total and 13.24 seconds of work budget. Local proof generation and verification measured about 2 seconds on the VPS; Kurier Finalized took about 19 seconds in addition to that proof work, so finalized mode is unsuited to the measured deadline. The real signed HTTP local proof regression completed in 1.59 seconds under a 14.75-second deadline, with proof, exact signals and HMAC checked and no Kurier/reference. This is test evidence, not live platform acceptance. Do not extend the earlier envelope deadline or assume a five-minute turn permits a five-minute HTTP request.

Overload, an expired response deadline or uncertain disk commit returns signed HTTP 503 with no action/key. A stored completed response remains replayable under load. Storage uncertainty disables readiness and future turns until recovery. These are transport failures, not valid policy submissions, and platform scoring remains a live acceptance check.

Invalid signatures return signed 401. Malformed or unsupported envelopes return signed 400. Authenticated conflicting game state for the same match/turn returns signed 409. UUID and commitment casing are canonicalized for identity while matchId is echoed exactly as received.

Five-second clock skew, 60-second request age, 32 KiB body limit, turn guard 0..20, local concurrency and retention are application controls, not claims of an exhaustive platform schema. The adapter itself implements the exact recovered comparator domain and the circuit's EXTRACT range 1..10. Accurate host time is required.

## Registration

The dashboard form was inspected without creating an agent or changing secrets. Registration collects name, selected tracks, a public personal GitHub repository and optional HTTPS endpoint. The selected VFY track needs an active commitment before pairing.

The publicly delivered commitment-form code requires a 32-byte hex hash and sends `{agentId,commitmentHash,circuitVersion,policyVersion}`. Both version fields display `v1` placeholders, but client validation only checks that they are nonempty. This adapter is circuit v1; confirm the policy-version label on the platform. It is distinct from the resolver version in turn requests.

`vk_hash` `0x6c56509f1c56fd1fd4e9737f906d2220f4b95f1d507f1adf6899085bd74be047` identifies the platform's mainnet verification key. It is not the private strategy's Poseidon commitment. Only the commitment hash is registered; never publish its parameter array or salt.

## Kurier on Volta (`finalized` mode only)

Local mode does not call this API. Finalized mode requires `KURIER_API_KEY` and retains the existing Volta submission and exact finality checks.

Base: `https://api-testnet.kurier.xyz/api/v1`.

POST `/submit-proof/{apiKey}` with:

```js
{
  proofType: 'groth16',
  vkRegistered: false,
  proofOptions: { library: 'snarkjs', curve: 'bn128' },
  proofData: { proof, publicSignals, vk: rawVerificationKey }
}
```

Private witness inputs are never sent. Omit `chainId` and `submissionMode`; the base URL selects Volta. Raw-key submission avoids assuming the mainnet vk_hash is registered on testnet.

Handle HTTP 200 `{jobId,optimisticVerify:"success"}` and HTTP 202 `{jobId,status:"pending"}`; reject optimistic failure even on HTTP 200. GET `/job-status/{apiKey}/{jobId}` returns a flat object. Wait through `Queued`, `Valid`, `Submitted`, `IncludedInBlock`; accept only exact `Finalized`, matching job ID, no errorDetails and a valid 32-byte txHash. Unknown/failure statuses fail closed.

`proofReference` is mapped from the finalized top-level `txHash`; Kurier has no field named proofReference. Poll every second within the deadline. No automatic submission retry is performed because Kurier has no documented POST idempotency key. Fetch errors are replaced with fixed codes because URLs contain API keys.

A live Kurier Finalized wait was measured at about 19 seconds, plus about 2 seconds for the local proof. This exceeds the observed practice work budget. Live platform acceptance of a local proof response remains unconfirmed; verify it with the owner's private environment before competition. If choosing finalized mode, also verify audit-pointer acceptance and deadline feasibility. Do not silently switch the configured network to mainnet.
