# Dependency and validation notes

Checked 2026-11-15. This is a development review, not an independent security certification.

## Applied dependency updates

The lockfile installs Zod 4.6.7, overrides all ws copies to 8.21.0, and overrides jsonpath@1.3.0's Underscore dependency to 1.13.8. circomlibjs 0.1.7 and snarkjs 0.7.6 are retained; no cryptographic downgrade was applied. Install scripts remain disabled in local setup and Docker builds.

The production audit after installation reports:

| Severity | Affected package entries |
| --- | ---: |
| Critical | 0 |
| High | 0 |
| Moderate | 0 |
| Low | 15 |

`npm audit --omit=dev --audit-level=moderate` passed. Plain `npm audit` exits nonzero because low-severity entries remain. Recheck advisories before deployment; results change over time.

The residual entries inherit https://github.com/advisories/GHSA-848j-6mx2-7j84 through circomlibjs -> ethers -> @ethersproject/signing-key -> elliptic 6.6.1. A fixed Elliptic release was not available at review time. The application never invokes ethers/Elliptic signing, never reads a wallet key, and uses circomlibjs for Poseidon only. Nevertheless, the package-root exports load ethers dependencies, so the installed dependency graph still carries the advisory. Do not apply `npm audit fix --force` blindly; its suggested circomlibjs downgrade does not preserve the intended proof/commitment dependencies.

## Completed checks

- Strict TypeScript build: passed.
- Full updated local suite: 132 tests passed, zero failures/skips, including circuit, real proof and engine tests.
- Tests include HMAC raw bytes and error signing, fixed Keccak vectors, response amounts, preflight, deadlines, durable replay, overload, uncertain storage completion, UUID-case echo and Kurier finality/error handling.
- Final targeted proof/cancellation regression: passed; abort kills the proving child and subsequent proof generation succeeds. The final build, loopback replay and artifact checks passed again after this addition.
- Local loopback replay: passed without production secrets.
- Official artifact checksums and Groth16/bn128 verification-key export: passed; the key exposes nine public signals.
- Real local proofs for HOLD, FORTIFY and EXTRACT verified against the official key; all nine public signals matched independently computed values.
- Each of the nine public-signal mutations was rejected for each action branch.
- Separate artifact analysis passed 46 witness constraint cases and 9 direct proving-key cases: an unaltered in-memory witness verified, while isolated changes to commitment/action/amount/active parameter/salt wires failed verification.
- Commitment CLI keeps private values out of stdout/stderr and rejects missing configuration.

The adapter is now implemented from official artifact behavior; no production strategy values are provided. See [CIRCUIT.md](CIRCUIT.md) for the recovered formulas and exact modular comparison domain. This is not a formal soundness proof over all possible witness assignments. No live Kurier transaction, platform preflight/practice run, Docker execution or VPS deployment was performed.

## Operational boundaries

Secrets are environment-only and excluded from source control and image context. Private witness values stay local; Kurier receives only proof, public signals and verification key. Logs contain fixed event names, not exception strings, request bodies, environment values or witnesses. The proof worker's output is discarded to avoid upstream diagnostics exposing private inputs.

The file store supports one service replica and process-restart recovery. It is not a distributed transaction coordinator or a guarantee against every filesystem/power-loss failure. Keep a persistent volume and back it up. An uncertain storage operation disables readiness and subsequent turns; inspect disk health and wait for the original process/I/O to stop before recovery. A completed durable response is never replaced by a successful HOLD solely because of overload or a storage timeout. In those conditions the transport returns signed HTTP 503 without claiming a policy submission.

The service uses Volta only and starts with competition disabled. Confirm fallback scoring, timestamp/turn bounds, raw-secret encoding, circuit semantics and testnet audit-pointer acceptance against the real platform before registering for scored matches.
