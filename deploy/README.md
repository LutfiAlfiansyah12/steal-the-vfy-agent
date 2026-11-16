# Docker + VPS deployment

> **Circuit integration is complete; private configuration and live validation remain.**
> The v1 policy, witness mapping, commitment and nine public signals were recovered
> from the pinned official WASM and checked with real local proofs against its zkey.
> No strategy parameter values have been selected. With only a valid HMAC secret,
> `/healthz` is 200 and `/readyz` is 503; turns safely return unproven HOLD.
> Configure your own private parameters and salt. Local proof response mode is
> the default and needs no Kurier key; explicit `finalized` mode needs a Volta key.
> Verify real platform practice acceptance before enabling scored competition.
> A healthy container or passing preflight does not establish live proof acceptance.

These files prepare one agent behind Caddy on a Linux VPS. Creating them does not
deploy anything. Read [the verified circuit contract](../docs/CIRCUIT.md) for slot
meanings and comparison limits before privately choosing your parameter values.

## Prerequisites

- Docker Engine and Docker Compose **2.30.0 or newer** on the VPS. This configuration
  uses Compose's `env_file` raw format.
- A public DNS hostname you control, supplied as `AGENT_DOMAIN`. Set its A record
  to the VPS address and publish an AAAA record only if IPv6 reaches that VPS.
  Use a hostname only, without a scheme, port, or path; no domain is assumed.
- Inbound TCP **80 and 443** available for Caddy's HTTPS and certificate challenges.
  Keep administrative access such as SSH restricted to trusted sources. Do not
  open port 3000. Allow outbound DNS and HTTPS for certificates and the Volta
  verifier.
- The project source, committed `package-lock.json`, and downloaded official
  `artifacts/manifest.json`, `artifacts/wasm/vfy-policy.wasm`, and
  `artifacts/zkey/vfy-policy_final.zkey`. The image build does not download or
  generate circuit artifacts. The runtime verifies pinned artifact checksums
  when initializing the proof engine; do not change pins to accept other files.

The image uses Node 24, installs from the lockfile with `npm ci --ignore-scripts`,
and explicitly runs `npm run build`. Its final stage contains production
packages, compiled code, and the official artifacts. Node runs as the nonroot
`node` user. The container launches the `npm start` entrypoint directly so it
receives shutdown signals through Compose's init process.

## Private environment and public hostname

Run the following instructions from the **project root** on the VPS (the directory
containing `package.json` and `Dockerfile`). Create the private environment file
locally with restricted permissions, then edit it with your preferred editor:

```sh
umask 077
touch .env
chmod 600 .env
```

Use these keys, replacing blank values privately as appropriate. This example
contains no credentials or strategy values:

```dotenv
AGENT_GAMES_HMAC_SECRET=
PROOF_VERIFICATION_MODE=local
KURIER_API_KEY=
STRATEGY_PARAMS_JSON=
STRATEGY_SALT=
```

- `AGENT_GAMES_HMAC_SECRET` must be the owner-supplied shared signing secret and
  contain at least 16 characters. An empty or invalid value prevents startup.
- `PROOF_VERIFICATION_MODE` accepts `local` or `finalized` and defaults to `local`.
  Local mode verifies the proof and all public signals locally, returns the proof
  bundle inside `policyProof`, and omits `proofReference` entirely. It makes no
  Kurier submission. `circuitVersion` and computed `publicInputsHash` remain included.
- `KURIER_API_KEY` is required only for `finalized` mode and must then be the owner's
  Volta testnet credential. A configured key may remain unused in local mode.
  Finalized mode submits the locally verified bundle and retains `waitFinalized`.
- `STRATEGY_PARAMS_JSON` and `STRATEGY_SALT` are selected and supplied privately by
  the owner. The parameter JSON is an ordered array of eight field-element strings,
  using the verified slot meanings in [CIRCUIT.md](../docs/CIRCUIT.md). No complete
  parameter tuple or strategy choice is supplied by this project.

Keep `.env` out of source control, images, logs, and shared transcripts. It is
already excluded by `.dockerignore`. With `format: raw`, write single-line
`KEY=value` entries without shell `export` or surrounding value quotes. Dollar
signs are preserved literally; JSON's own internal quotes remain part of its
value. Do not source this file into a shell.

`env_file: ../.env` in `deploy/compose.yaml` is resolved relative to that Compose
file, so it loads **the project-root `.env`**, not `deploy/.env`. The agent's HMAC
secret comes only from this service `env_file`: there is no build argument or
Compose `environment` override for it. The private file is not mounted into the
container. Caddy receives only the public hostname, not the private env file.

Export the public hostname separately in each operator shell:

```sh
export AGENT_DOMAIN='REPLACE_WITH_YOUR_PUBLIC_DNS_HOSTNAME'
```

Replace that marker with your own hostname before running Compose. Compose fails
if `AGENT_DOMAIN` is absent or empty. The commands below use `--env-file /dev/null`
to disable automatic `.env` loading for Compose's own interpolation; the agent
still receives `../.env` through its service `env_file`. This keeps literal private
values out of Compose interpolation while the exported public hostname is used
for Caddy.

Compose does not explicitly override `PROOF_VERIFICATION_MODE`: set it in the
private project-root `.env` service file, or omit it to use the application's
`local` default. Exporting a shell variable alone does not pass it into this
service. The commands' `--env-file /dev/null` disables private `.env` interpolation
but does not disable the raw service `env_file`. If a future Compose configuration
explicitly sets `${PROOF_VERIFICATION_MODE:-local}`, that `environment` value takes
precedence over the raw private file and must be controlled by the exported public
operator environment instead.

Compose fixes `HOST=0.0.0.0`, `PORT=3000`,
`ARTIFACT_DIRECTORY=/app/artifacts`, and `DATA_DIRECTORY=/app/runtime`.
It keeps `ZKVERIFY_NETWORK=volta` and `ALLOW_COMPETITION=false`; these explicit
values take precedence over the private env file. Leave competition disabled
until practice acceptance is confirmed. Enabling it later requires a deliberate
configuration change after the tournament-readiness prerequisites are satisfied.

## Build and start when the owner is ready

These are operator instructions, not commands that have been run for you:

```sh
docker compose --env-file /dev/null -f deploy/compose.yaml config --quiet
docker compose --env-file /dev/null -f deploy/compose.yaml build --pull
docker compose --env-file /dev/null -f deploy/compose.yaml up -d --scale agent=1
docker compose --env-file /dev/null -f deploy/compose.yaml ps
```

Use `config --quiet` when checking syntax: full resolved configuration output can
include private env values. Caddy obtains certificates automatically when the
hostname resolves and the public ports are reachable. Caddy stores certificates
and account data in the persistent `caddy_data` volume, with configuration state
in `caddy_config`.

Only Caddy publishes host ports: TCP 80 and 443 map to its internal 8080 and 8443
listeners. HTTP redirects to public HTTPS port 443. HTTP/1.1 and HTTP/2 are enabled;
no UDP port is required. `/agent`, `/healthz`, and `/readyz` are proxied to
`agent:3000`; the agent has no published host port. Register the endpoint
`https://YOUR_PUBLIC_DNS_HOSTNAME/agent` only with your actual hostname and after
completing the required readiness and testnet checks.

Verify transport and liveness separately from readiness:

```sh
curl --fail --show-error --silent "https://${AGENT_DOMAIN}/healthz"
curl --show-error --silent --output /dev/null --write-out '%{http_code}\n' \
  "https://${AGENT_DOMAIN}/readyz"
```

Expect **200** for liveness after startup. Readiness is **503** while private
parameters, salt or pinned artifacts are missing/invalid, and **200** after
proof-engine initialization, provided storage is healthy and turns are accepted.
Valid HMAC configuration is required for HTTP startup. Local mode does not gate
readiness on `KURIER_API_KEY`; finalized mode additionally requires that key.
Docker's health check uses Node's built-in
`fetch` against `/healthz`, so incomplete proof configuration does not prevent Caddy
from starting. Valid authenticated turns return unproven HOLD when proving is
unavailable; malformed or unauthenticated requests are rejected. Docker marks failed liveness
checks unhealthy; its restart policy restarts exited processes, not a running
process solely because it is unhealthy.

A 200 from `/readyz` indicates initialized proof configuration, not live platform
acceptance or chain finality. The current `/build` VFY contract explicitly supports
offline verification, with `proof` and `public_signals` inside `policyProof` and a
required `circuitVersion`; the onchain reference is only an optional audit pointer.
The user approved the local response path as a change to the original frozen
finality requirement. Local verification does not imply finality or satisfy that
original requirement.

Before tournament use, confirm authenticated platform practice acceptance and
fallback behavior for the selected mode. An observed practice envelope allowed
about 14.75 seconds total and 13.24 seconds of work; local proof generation plus
verification measured about 2 seconds on the VPS. Kurier Finalized took about
19 seconds in addition to the local proof, so finalized mode is unsuited to that
measured deadline. `MAX_TURN_MS` remains 25 seconds, bounded by the earlier envelope
deadline with the 1.5-second response reserve. No live platform acceptance of the
local response has yet been confirmed.

## Single replica and persistent storage

**Run exactly one agent replica.** `scale: 1` expresses this requirement; do not
override it, start a second Compose project for the same agent, or share the store
between active deployments. The file store is not a distributed coordination
service.

The `agent_runtime` named volume is mounted at `/app/runtime`. A fresh volume
inherits the image directory's `node` ownership and private permissions. If
restoring or migrating storage, preserve ownership for the image's `node` user
(UID/GID 1000). Do not replace this volume with ephemeral container storage.

The application reserves a turn in the file store **before proving**. Completed
retries replay the saved response; an unfinished reservation after a crash falls
back to HOLD rather than submitting the proof again. Preserve this state across
restarts, rebuilds, and upgrades. Deleting reservations or using a fresh volume
for the same agent loses crash/retry protection.

The agent filesystem is read-only except for `/app/runtime` and a temporary
`/tmp` tmpfs. Both services drop all capabilities and enable
`no-new-privileges`; Caddy additionally writes only to its data/configuration
volumes and temporary storage. The agent receives SIGTERM and has about ten
seconds to finish shutdown, with a 12-second Compose grace period.

For a stop, backup, or update, use the same project and env settings:

```sh
docker compose --env-file /dev/null -f deploy/compose.yaml stop
# Back up agent_runtime, caddy_data, and caddy_config while the services are stopped.
docker compose --env-file /dev/null -f deploy/compose.yaml build --pull
docker compose --env-file /dev/null -f deploy/compose.yaml up -d --scale agent=1
```

Keep the Compose project name stable so subsequent starts reuse the same volumes.
Back up the private env file separately with appropriate access controls.
`docker compose down` retains named volumes; **do not use `down --volumes` or prune
these volumes** while their agent state and certificates are needed. Changes to
`.env` require container recreation with `up -d`; a plain `restart` does not load
new environment values.

## Validation limits

Docker and Caddy are not installed in the authoring environment. Image builds,
Compose validation with the Docker CLI, container permissions, HTTPS issuance,
and shutdown behavior were not tested there. Separate VPS measurements established
about 2 seconds for local proof generation/verification and about 19 seconds for
Kurier Finalized, but do not establish platform acceptance or every deployment
property. Run the checks above on the intended VPS before relying on these files.
Supply the owner's private configuration and verify live practice acceptance before
enabling scored matches; finalized mode also needs acceptable audit-pointer and
finality timing checks.
