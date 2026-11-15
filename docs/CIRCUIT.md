# Verified VFY v1 circuit adapter

This is an artifact-derived specification, not organizer-published Circom source. It was recovered from the exact official `vfy-policy.wasm` and checked against `vfy-policy_final.zkey` with real local Groth16 proofs. A public participant reference supplied candidate names, but the implementation is validated against the official binaries, not against that participant's strategy.

## Artifact identity

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| vfy-policy.wasm | 2,991,212 | bc0998250d2baf75b89deef5306867ffa7085a08d4f7d2caf0dd63a060b134d2 |
| vfy-policy_final.zkey | 810,586 | f9666a1655279ef27f7fee6d535ac8aa9e39286ac40ff6279fea87c21ab6ce41 |

Sources: https://agentgames.zkverify.io/build and its linked https://agentgames.zkverify.io/circuits/vfy-policy.wasm / https://agentgames.zkverify.io/circuits/vfy-policy_final.zkey.

Circom metadata: 2.2.3; 17 flattened input slots; 1909 witness variables; 9 public signals; Groth16 on BN128. Scalar field:

```text
r = 21888242871839275222246405745257275088548364400416034343698204186575808495617
```

The runtime rejects noncanonical field inputs; it never silently reduces an out-of-range envelope or private value into the field.

## Owner-selected parameters — no defaults

`STRATEGY_PARAMS` remains an unset TODO in source. Actual values come only from the private environment variable `STRATEGY_PARAMS_JSON`: a JSON array of exactly **eight strings**, decimal or `0x`-hex, in the following order. No complete example tuple is provided because those choices belong to the owner.

| Index | Circuit meaning | Circuit requirement |
| --- | --- | --- |
| 0 | Amount used when the policy selects EXTRACT | Integer 1 through 10 inclusive |
| 1 | Self-balance comparison threshold | Canonical field element; see comparison domain below |
| 2 | Opponent-balance comparison threshold | Canonical field element; see comparison domain below |
| 3 | Extraction-disable flag | Boolean field element: 0 or 1 |
| 4–7 | Reserved circuit inputs | Must each be zero |

The numeric bounds, Boolean encoding, and reserved zeros above are constraints imposed by the downloaded circuit, not a suggested strategy. The owner chooses slots 0–3 and the private salt. `STRATEGY_SALT` is a separate canonical field-element string. Never publish these values or put them in a model prompt.

## Exact policy semantics

The pinned circuit implements the following fixed family of parameterized policies:

```text
low   = LT16(selfBalance, params[1])
rich  = LT16(params[2], opponentBalance)
steal = rich AND (params[3] == 0) AND NOT low

actionCode = low + 2 * steal
amount     = params[0] if actionCode == 2, otherwise 0
```

Action encodings are HOLD=0, FORTIFY=1, EXTRACT=2. Thus the low-balance condition takes priority; the extraction-disable flag does not disable FORTIFY. Both comparisons are evaluated even if the first selects FORTIFY, as the circuit constrains both. This is circuit transcription, not a new heuristic or competitive choice.

For operands in ordinary unsigned 16-bit range, `LT16(a,b)` is ordinary `a < b`. The actual compiled comparator has the more precise behavior:

```text
shifted = (65536 + a - b) mod r
require shifted < 131072
LT16(a,b) = shifted < 65536
```

There are no separate uint16 checks on each balance or threshold in the compiled policy. The adapter reproduces the difference/field behavior exactly and rejects inputs outside the comparator domain. It does not invent an operand range or silently reinterpret the field comparison as an unrestricted bigint comparison. If the chosen thresholds put a live state outside this domain, proving fails closed. Boundary tests cover both shifted endpoints and operands greater than 16 bits.

Fortification-history fields are part of the HTTP state but are not circuit inputs. Version v1's policy does not use them, the turn number, or match ID for the action choice. Match and turn are nevertheless bound into the public proof signals.

## Commitment and binding

Both use circomlibjs Poseidon on the BN128 scalar field.

```text
commitment = Poseidon([
  params[0], params[1], params[2], params[3],
  params[4], params[5], params[6], params[7],
  salt
])

binding = Poseidon([matchIdInteger, turnNumber, circuitVersion])
```

The salt is the **last** of nine commitment inputs. Binding is a three-input Poseidon over **match ID, turn, circuit version**; it does not use the salt. For this adapter `circuitVersion = 1`.

`npm run commitment` prints only the commitment as a padded 32-byte `0x` hex string. It exits with a generic error and no hash when the private configuration is missing or invalid. Keep the same params/salt throughout the period in which the platform freezes the commitment.

## Witness interface

| WASM input name | Value |
| --- | --- |
| commitment | The envelope's commitment, canonical decimal field string |
| matchId | UUID with hyphens removed, interpreted as hex, then decimal string |
| turnNumber | Envelope `turn`, decimal string |
| selfBalance | Envelope self balance, decimal string |
| opponentBalance | Envelope opponent balance, decimal string |
| action | Numeric action code, decimal string |
| amount | EXTRACT amount, otherwise decimal zero |
| circuitVersion | Decimal one |
| salt | Private field value, decimal string |
| strategyParams | Private array of eight decimal field strings |

The envelope field is `turn`; the witness field is **`turnNumber`**. The input map contains 9 scalars plus 8 array elements, totaling 17 slots. All input names and flattened lengths were checked with the official WASM's input lookup table.

## Public-signal order

The generated Groth16 vector has exactly nine canonical decimal strings:

```text
[
  binding,
  commitment,
  matchIdInteger,
  turnNumber,
  selfBalance,
  opponentBalance,
  actionCode,
  amount,
  circuitVersion
]
```

The adapter computes **all nine** expected values independently before proof generation/submission and compares them exactly with snarkjs output. The worker then verifies the proof against the verification key exported from the pinned zkey.

`policyProof.publicInputsHash` is a different operation: Keccak-256 over the last eight named fields, each encoded as 32-byte big-endian. Neither Poseidon binding nor public signals may be replaced with that audit hash.

## Evidence and reproducible checks

The main `VfyPolicyProof_154_run` function in a WebAssembly text disassembly of the pinned WASM exposes these source-line diagnostics and operations:

- Original circuit lines 63–71 wire parameters in array order and salt into the nine-input Poseidon; line 72 checks commitment equality.
- Lines 75–78 require reserved parameters 4–7 to be zero.
- Lines 90/95 enforce the extraction amount bounds; line 98 enforces the Boolean flag.
- Line 140 checks the derived action; lines 149/153 check EXTRACT amount and non-EXTRACT zero amount.
- Lines 157–159 feed matchId, turnNumber and circuitVersion to the three-input Poseidon output binding.

These line numbers are embedded diagnostic labels from the compiled circuit, not a claim that the original `.circom` file was published. WAT structural analysis was complemented by 46 synthetic witness constraint checks and real local proofs for all three actions. The complete public vector matched independently calculated values; modifying each of its nine positions invalidated verification. A separate test proved from in-memory witness bytes: an unchanged witness verified, while individual changes to commitment, action, amount, each active parameter or salt produced proofs that failed verification (9 cases total). No private witness files were written. Synthetic test parameters are generated internally and are never production defaults.

The zkey contains 1906 constraint rows under snarkjs's public-input-padding convention; 737 have nonzero A and B sides. The reserved parameters are optimized out of the witness, and the WASM requires their input values to be zero. No plaintext R1CS/C matrix or original source was available. These checks establish the reported behavior and tested mutation rejection, not a formal soundness proof for every possible witness assignment.

Run the maintained suite from the project root:

```sh
npm test
```

The circuit proof tests use the downloaded artifacts and terminate isolated child processes after verification. A process boundary is intentional: snarkjs 0.7.6's web-worker dependency cannot create its nested verifier workers correctly when invoked from a Node worker_thread. Private witness data is sent over IPC; child diagnostics are discarded. The owner's optional smoke check uses a matching public envelope and private environment:

```sh
npm run test:proof -- /absolute/path/to/public-turn-envelope.json
```

A successful local proof is not evidence of live Kurier finality, dashboard preflight, VPS deadline performance, or tournament acceptance. Those checks remain necessary after the owner configures private values.

## Registration metadata

Dashboard commitment registration has `commitmentHash`, `circuitVersion`, and **`policyVersion`**, in addition to the selected agent ID. Both version fields show `v1` as UI placeholder; the visible client only enforces nonempty version strings. The adapter corresponds to circuit v1. Confirm the applicable policy-version label with the platform before registering; do not treat a UI placeholder as a complete server-side version contract.

The platform's published `vk_hash` identifies the registered mainnet verifier. It is not the owner's Poseidon strategy commitment. Volta testnet uses raw verification-key submission in this implementation.
