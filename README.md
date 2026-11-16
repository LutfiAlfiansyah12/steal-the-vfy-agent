# Steal the VFY agent

TypeScript / Node.js 24 service for Docker + VPS, with Caddy providing public HTTPS. The **v1 circuit adapter is implemented and locally verified against the official WASM/zkey**. It computes the circuit's policy from the owner's parameters, generates Groth16 proofs, independently checks all nine public signals, and returns the locally verified proof bundle by default. An explicit `finalized` mode submits that bundle via Kurier on Volta testnet and waits for Finalized.

**Your strategy remains yours.** `STRATEGY_PARAMS` is still an unset TODO. No production parameter values, salt, API key, wallet or HMAC secret are supplied. With only the HMAC configured, signed preflight works and turns return unproven HOLD; `/readyz` stays 503 until private parameters, salt and pinned artifacts initialize successfully. Local mode needs no `KURIER_API_KEY`; `finalized` mode requires the owner's Volta Kurier credential. Live platform acceptance and VPS deployment still need verification before scored matches.

## Layout

```text
src/
  main.ts                   environment, startup, graceful shutdown
  server.ts                 raw-body HMAC, preflight, POST /agent
  protocol/                 schemas, HMAC, exact eight-word Keccak audit hash
  strategy/vfy-v1.ts         verified policy, witness map and public-signal calculation
  strategy/params.ts         STRATEGY_PARAMS TODO and private environment parser
  strategy/commitment.ts     Poseidon commitment calculation
  proving/                  pinned artifacts, cancellable worker, local proof verification
  verification/kurier.ts     optional Volta submission and Finalized polling
  runtime/                  deadlines, durable turn reservations and response replay
scripts/                    artifact download/check, commitment, real proof smoke, loopback replay
tests/                      protocol, runtime, circuit, real proof and mocked Kurier checks
deploy/                     Docker Compose, Caddy and VPS instructions
docs/CIRCUIT.md              artifact-derived circuit semantics and owner parameter meanings
docs/PROTOCOL.md             official protocol references and unresolved interoperability details
```

## Local setup

Use Node.js **24 LTS** and npm. From this directory:

```sh
npm ci --ignore-scripts
npm run artifacts:download
npm run build
npm test
npm run artifacts:check
npm run replay
```

`npm test` includes real local proof tests using the official artifacts. Generated test parameter tuples are temporary fixtures, never production defaults. No test submits a proof externally or reads production credentials. The self-contained replay starts a loopback server with a temporary random HMAC secret, checks preflight/rejection/HOLD/replay, then cleans up.

Copy `.env.example` to `.env` and edit it privately. `npm start` uses Node's native environment loader. Never paste secrets or strategy values into chat or commit them. Required for HTTP startup: `AGENT_GAMES_HMAC_SECRET`, using the exact plaintext from Dashboard → Rotate Secret.

```sh
npm start
```

Endpoints: `http://127.0.0.1:3000/healthz`, `http://127.0.0.1:3000/readyz`, and `http://127.0.0.1:3000/agent` (POST). Production registration must use the full public HTTPS URL ending in `/agent`.

## Configure your own strategy

The circuit supports a fixed policy family. Read [the verified circuit contract](docs/CIRCUIT.md) for its precise comparison semantics and required parameter ordering. The adapter implements that existing family; it does not invent or optimize a strategy.

- `STRATEGY_PARAMS_JSON`: an ordered JSON array of exactly eight **strings**. Slots 0–3 are your extraction amount, self threshold, opponent threshold and Boolean extraction-disable flag. Slots 4–7 are protocol-reserved and must be zero. The extraction amount must be 1–10; the flag must be 0 or 1. Thresholds must be canonical field elements and remain within the circuit's comparison domain for each state.
- `STRATEGY_SALT`: your private canonical field-element string.
- `PROOF_VERIFICATION_MODE`: `local` or `finalized`; defaults to `local`. Local mode returns the proof after strict local verification and does not submit to Kurier. Finalized mode submits to Kurier on Volta and waits for exact Finalized status.
- `KURIER_API_KEY`: a **Volta testnet** credential from https://testnet.kurier.xyz, required only when `PROOF_VERIFICATION_MODE=finalized`.

No example strategy tuple is included. Keep the TODO constant in source unset; the environment loader supplies the runtime values. Never log or reveal them.

Once you have configured these privately:

```sh
npm run commitment
npm run test:proof -- /absolute/path/to/public-turn-envelope.json
```

The commitment script prints only the padded 32-byte hex commitment on stdout; errors do not echo values. It refuses to print a hash if configuration is missing or invalid. The proof-smoke command requires a public turn envelope with the matching commitment, derives the action locally, verifies the real proof and exact public signals, and prints no witness, action, proof or parameter values. It does not submit to Kurier. The response service uses the same local verification path in its default `local` mode.

The strategy commitment is `Poseidon(params[0..7], salt)`, with salt last. It is **not** the platform's mainnet `vk_hash`. The ninth public signal issue is resolved: the first signal is `Poseidon(matchIdInteger, turnNumber, circuitVersion)`, followed by the eight declared public fields. See [CIRCUIT.md](docs/CIRCUIT.md) for evidence, ranges and full ordering.

## Runtime behavior

- Verify HMAC-SHA256 over raw request bytes before UTF-8 decoding/JSON parsing. Serialize each response once, sign those exact bytes and send them unchanged. HMAC header encoding is bare hex per the official guide.
- Compute the audit hash with the exact eight 32-byte big-endian words from `/build`. Separately compute and compare all nine circuit public signals before returning or submitting a proof.
- Accept only a matching commitment, circuit-derived action, locally verified Groth16 proof, exact public signals and the required response-mode evidence. In `local` mode, the locally verified proof bundle is returned directly and `policyProof.proofReference` is omitted entirely. In `finalized` mode, submit to Kurier and accept only a validated **Finalized** transaction; `Submitted`/`IncludedInBlock` are insufficient. `policyProof` always includes the required `circuitVersion`, `proof`, `public_signals`, and computed `publicInputsHash` for a successful proof response.
- Run CPU-heavy proving in a cancellable child process. Private witness data travels over IPC, never process arguments/environment or files. Its stdout/stderr is discarded; logs contain fixed event names, not errors, bodies, witnesses or environment values. No LLM is called. Local mode stops after strict local proof and public-signal verification; finalized mode then submits the same verified bundle to Kurier and waits for exact Finalized status.
- On a proof/verification error within a writable turn budget, persist and return signed HOLD without a fake proof or reference. An emergency HOLD may not be provable under the committed policy; the platform documents no-proof HOLD substitution. Verify scoring in practice.
- On overload, expired response deadline or uncertain storage finalization, return signed HTTP 503 without a claimed action/key. A durable result can still be replayed at capacity. Disk uncertainty disables readiness and subsequent turns until operator recovery, avoiding conflicting successful responses after a late write.
- Flush a reservation to disk **before** proving/submission. Concurrent duplicates share work, completed duplicates replay the same decision, changed state conflicts, and unfinished reservations after a crash become HOLD rather than another paid submission. UUID case changes preserve the decision and key while echoing the current request's matchId spelling.
- Run **one replica** with a persistent volume. The file store is not a distributed coordinator or a guarantee against every power-loss/filesystem failure. Retain records through the tournament and back up the volume. Stored proofs/responses are public evidence, never the private witness.
- Work ends at the earlier of the envelope deadline and the configurable local ceiling (25 seconds by default), with 1.5 seconds reserved for storage/response. An observed platform practice envelope left about 14.75 seconds, or 13.24 seconds of work budget. Local proof generation plus verification measured about 2 seconds on the VPS; the measured Kurier Finalized wait was about 19 seconds in addition to that local proof work, making finalized mode unsuitable for that measured envelope. The 25-second ceiling does not extend a shorter envelope deadline. Keep VPS time synchronized.

## Deploy and register

1. Choose your own private parameters and salt, run real local proof checks, then validate the selected response mode using unscored practice. Local mode performs offline verification and does not require a Kurier key. Finalized mode additionally requires live finalized submission on Volta. Testnet is the only enabled network and `ALLOW_COMPETITION=false` by default.
2. Follow [the VPS deployment guide](deploy/README.md). Register `https://YOUR_DOMAIN/agent` and the public source repository in Dashboard → My Agents.
3. Rotate the HMAC secret, install its one-time plaintext privately, recreate/restart the service, and run dashboard preflight. Preflight tests authentication/signing, not complete proof readiness.
4. Compute your commitment privately and enter **only the hash** in Edit agent → Steal the VFY, before pairing. The form also asks for `circuitVersion` and `policyVersion`; both UI placeholders are `v1`. Use circuit `v1` for this adapter and confirm the applicable policy-version label with the platform. Do not confuse either field with `resolverVersion`.
5. Keep the same params/salt/circuit while the platform freezes your commitment. Confirm live practice proof acceptance, turnaround time and failure behavior before enabling scored competition. If using `finalized`, also confirm Volta audit-pointer acceptance; local mode intentionally omits the optional `proofReference`.

The published game `vk_hash` is registered on **mainnet**. In finalized mode this client submits the raw verification key on Volta, so it does not assume that mainnet hash is already registered on testnet. Kurier does not require a wallet key for this implementation. Local mode does not submit externally. No deployment, registration, secret rotation or external proof submission is performed by the local scripts.

## Validation and limits

The circuit's accepted input names, commitment order, deterministic policy and all public signals were checked against the official binary. Real local proofs for HOLD, FORTIFY and EXTRACT verified successfully, and changing each public signal invalidated verification. The full updated suite passed **147/147 tests**, including raw HMAC, audit hash, deadline/replay behavior, circuit constraints, real proofs, commitment CLI confidentiality, both response modes and mocked Kurier finality. A real signed HTTP local proof response completed in 1.59 seconds under a 14.75-second deadline, checking proof, exact signals and HMAC with no Kurier submission or `proofReference`. Real proof generation plus local verification for each branch took roughly 1.3–1.6 seconds on the authoring machine and about 2 seconds in the VPS measurement; these are measurements, not live platform acceptance or latency guarantees.

Security updates applied: Zod 4.6.7, ws 8.21.0 and Underscore 1.13.8. The latest production audit has **0 critical/high/moderate and 15 low** affected-package entries from the unresolved Elliptic/ethers chain. `npm audit --omit=dev --audit-level=moderate` passes; an unfiltered audit is nonzero. No Elliptic signing is used. See [SECURITY.md](docs/SECURITY.md).

**Still unverified:** live platform acceptance of the local proof response, fallback scoring, and end-to-end response reliability on every practice deadline. A real Kurier Finalized path and roughly 2-second local proof verification were measured on the VPS, but the observed roughly 19-second Kurier wait plus local proof time is unsuited to the 14.75-second practice envelope (13.24-second work budget). Local proof responses are a user-approved change from the original frozen finality requirement; local verification neither implies onchain finality nor satisfies that original requirement. Keep competition disabled until practice acceptance is confirmed.
