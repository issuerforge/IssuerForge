# IssuerForge

Compliance-native stablecoin issuance on Solana. The rules are enforced by the
token itself — a Token-2022 mint with a transfer hook — not by an application
that can be bypassed. An issuer composes a policy in a wizard, signs three
transactions, and from then on every transfer, from any wallet or any client,
passes the same on-chain check.

**Policy is data, not code.** One audited program (`issuer_forge`) serves every
issuer. Each issuer's rules live in an on-chain account and change without
re-issuing the token or migrating holders.

## What is built (milestone M1, closed 2026-09-16)

Everything below is deployed on devnet and measured by a script, not by eye.

| Criterion | Budget | Measured on devnet |
|---|---|---|
| Wizard → working token on a clean account | ≤ 5 min | **10.1 s** end to end through the API (9.5–10.0 s for the on-chain half alone; 1.9 s on a local validator) |
| Transfers that violate a rule are refused | 100 % of ≥ 50 attempts across four vectors | **64 of 64**, three runs in a row — third-party client, CPI through a hostile program, delegate, and splitting under the per-transfer limit |
| Cost of a checked transfer vs. an unchecked one, in lamports | ≤ 2× | **1.00×** (5 000 vs. 5 000) |
| Cost of a checked transfer, in compute units | < 100 000 CU | **52 410 – 70 410 CU** (unchecked: 2 045) |
| Initial issuance above the attested reserve | 0 of ≥ 10 attempts | **10 of 10 refused** |
| Wizard simulation vs. on-chain outcome | 0 mismatches on ≥ 15 scenarios | **16 of 16 agree** — same refusal *code*, not merely "also refused" |

The spread in compute units between runs is not measurement noise: PDA
derivation walks the bump downwards, and a bump of 254 costs a couple of
thousand CU more than 255. The number is reported as a range on purpose.

The 10-second issuance time is bounded by the free public devnet RPC, not by
the chain or the program — the same issuance takes 1.9 s against a local
validator.

### Devnet addresses

| Program | Address |
|---|---|
| `issuer_forge` | `DLkwvpN7EjtXLiXJFMiibLf7NXgFFFTBCmMcFvKgsGe5` |
| `attacker` (measurement-only CPI relay) | `9ZCmUGqkrtBrm83uiiMwBgRrV2cBPE9HGMgA25iRJGkQ` |

### What M1 deliberately does not include

- **No compliance actions yet.** Freezing an account, seizing funds and
  pausing circulation are milestone M2. The 2-of-N quorum exists today only on
  policy changes, and only as signatures within a single transaction —
  proposals with deferred signing and a revocation window come with M2.
- **No continued minting.** Initial issuance is checked against the attested
  reserve; a separate `mint` instruction does not exist yet — not disabled,
  absent. That is M3.
- **No public transparency page.** M3.
- **Fixtures where real-world services would be.** The reserve attestation is
  published by our own key acting as attestor — the mechanism is real, the
  content is a fixture. Holder statuses (tier, jurisdiction, denial) are
  written by the issuer's own register; there is no KYC provider integration.
- **No indexer.** Tokens and holders reach the database through the API; the
  worker that mirrors on-chain state back into it is M2 (`apps/worker` is a
  stub today).

## Design rules the code is built around

- **The hook never creates accounts.** `HolderStatus` and `VelocityCounter`
  are created when a holder is thawed. A missing account means the transfer is
  refused — never skipped.
- **The platform's operational key never signs money.** Minting, seizing,
  pausing and policy changes require the issuer's 2-of-N quorum, and the
  program verifies it. The operational key is limited on chain to a delegation
  mask (thawing holders, updating the issuer's own status register), and the
  issuer can revoke it in one action. Revocation does not freeze onboarding:
  every delegated route also works unsigned, returning the transaction to the
  issuer's own wallet.
- **Two implementations of the rules model, one truth.** The Rust evaluator
  inside the hook and the TypeScript simulator behind the wizard are checked
  against each other by differential tests on a shared fixture, and against
  the live network by the demo (the 16-of-16 above). Without those the two
  copies would drift silently.
- **Tenant isolation comes from the roster, not the request.** The API derives
  `issuer_id` from the wallet's membership in an issuer's roster; a header can
  narrow the choice among proven memberships but can never grant one.
- **No `any`. Zod at every API boundary. Comments explain *why*, never
  *what*.**

## Repository layout

```
programs/issuer-forge   Anchor program: issuer config, policy, transfer hook,
                        holder status, velocity counters, reserve check
programs/attacker       Minimal hostile program for the CPI attack vector.
                        No tests and no checks — on purpose; it is a probe.
packages/chain          Vendored IDL, PDAs, transaction builders, base58,
                        program-error decoding. The only source of the
                        program address.
packages/policy         Rules model in TypeScript: canonical binary layout,
                        rules hash, transfer simulation, scenario catalogue
packages/shared         Error codes, API primitives, indexed event types,
                        refusal codes (shared by indexer and verifier)
packages/db             Drizzle schema and migrations (Supabase/Postgres).
                        RLS is on from the first migration, with no policies
                        yet — deny-all except the owner.
apps/api                Hono. Login (Privy), roster, policy simulation, token
                        issuance (unsigned transactions), holder onboarding
apps/web                React console: issuance wizard with live simulation,
                        three signatures shown as three
apps/worker             Indexer stub (M2)
tools/demo              The measurement script behind the table above
tools/spikes            Feasibility spikes kept with their tests (can the hook
                        resolve a provider attestation directly? — it can)
scripts/                WSL build/test/localnet helpers, IDL sync
.github/workflows/      Pages deploy of the console, keep-alive ping of the api
render.yaml             Render Blueprint for the api (one free web service)
docs/                   SPEC, PLAN, TASKS, SCRATCHPAD — not tracked in git
```

## Stack

Node 26 (runs `.ts` directly, no build step for the api) · pnpm workspaces (no
Turborepo) · TypeScript 5.9 strict · Biome · Vitest 4 ·
Hono · Drizzle + Supabase · React 19 + Vite 8 · Anchor 0.32.1 / Token-2022 ·
Solana CLI 4.2 · Rust 1.97 · mollusk-svm 0.15 for program tests

Pinned on purpose — do not "update while you are at it":
`spl-transfer-hook-interface = 0.10.0` (2.x splits `Pubkey` into two
incompatible types), `solana-address 2.6.1`, `mollusk-svm 0.15.0` instead of
`litesvm` (which does not compile against Anchor 0.32.1).

## Getting started

```bash
pnpm install
cp .env.example .env      # fill in DATABASE_URL and the keys; see comments inside
pnpm gate                 # idl:check + lint + typecheck + test — green before every commit
```

### Database

Supabase needs **two** connection strings: the session pooler on port 5432 for
DDL, the transaction pooler on port 6543 for the API (`prepare: false` is set
for exactly that). The direct `db.<ref>.supabase.co` host is IPv6-only and
will not resolve from most networks. Connect as `postgres`, not `anon` —
RLS is enabled with no policies, so any other role sees empty tables without
an error.

```bash
DATABASE_URL=<session pooler, port 5432> pnpm --filter @forge/db db:migrate
```

### On-chain program (WSL only)

The Anchor toolchain runs in WSL; invoke it from PowerShell, not Git Bash
(Git Bash rewrites `/mnt/...` paths):

```powershell
wsl.exe -e bash /mnt/<repo>/scripts/wsl-build.sh     # anchor build
wsl.exe -e bash /mnt/<repo>/scripts/wsl-test.sh      # cargo test, all targets
wsl.exe -e bash /mnt/<repo>/scripts/wsl-localnet.sh  # local validator with both programs in genesis
```

`wsl-test.sh` runs every target, not just `--lib`: the differential check
against the TypeScript rules model lives in `tests/rules.rs`.

### Running the apps

```bash
pnpm --filter @forge/api start   # http://localhost:8787, reads ../../.env
pnpm --filter @forge/web dev     # http://localhost:5173
```

### The demo / measurement script

`tools/demo` creates an issuer from scratch on every run — that is what
"on a clean account" means — issues a token, onboards holders, checks the
simulator against the network, measures the cost of a checked transfer, and
then throws 64 rule-violating transfers and 10 over-reserve issuances at it.

```bash
# local validator, funded from the faucet
node --env-file=.env tools/demo/src/main.ts --rpc http://127.0.0.1:8899

# devnet, funded by transfer from the deploy wallet (the faucet is rate-limited)
node --env-file=.env tools/demo/src/main.ts \
  --rpc https://api.devnet.solana.com --payer ~/.config/solana/id.json

# the same, with issuance and onboarding routed through the API
# (requires the API running and DATABASE_URL set)
node --env-file=.env tools/demo/src/main.ts \
  --rpc https://api.devnet.solana.com --payer ~/.config/solana/id.json \
  --api http://127.0.0.1:8787
```

With `--api` the demo replaces two things it cannot have on a fresh run. It
writes the issuer's roster into the database itself (the indexer that will do
this is M2), and it stands in for Privy through `PRIVY_API_URL`: a fixture
answers the same `GET /api/v1/users/<did>` request with the run's wallets, and
the access token is signed with the key whose public half is in
`PRIVY_VERIFICATION_KEY`. The API's authentication code is not modified — it
verifies signature, audience and expiry exactly as in production.

Public devnet RPC rate-limits aggressively; the demo paces its requests with a
token bucket, and `web3.js` retries on `429`. Expect a handful of retry lines
per run.

## Deploying for free

The console is a static bundle and the api is one Node process, so the whole
thing runs at $0: **GitHub Pages** for the console, **Render** (free web
service) for the api, **Supabase** for Postgres. Nothing here touches mainnet.

```
https://issuerforge.github.io/IssuerForge/   apps/web   GitHub Pages, on every push to main
https://issuerforge-api.onrender.com         apps/api   Render Blueprint, on every push to main
```

**Console → GitHub Pages** (`.github/workflows/pages.yml`). Once, in the
repository settings:

1. *Settings → Pages → Source:* **GitHub Actions**.
2. *Settings → Secrets and variables → Actions → Variables* (not
   *Environments*): `VITE_API_URL` = the Render URL, `VITE_PRIVY_APP_ID` = the
   Privy app id. `VITE_DEVNET_RPC_URL` is optional and defaults to the public
   devnet node — the paid node with a key stays on the api side, because
   everything in `VITE_*` is baked into a public bundle.

A project site lives under `/IssuerForge/`; the workflow passes that as
`BASE_PATH` to Vite and the router picks it up as `basename`. Pages has no
rewrites, so the workflow copies `index.html` to `404.html` and deep links
land in the router. For a custom domain set the variable `PAGES_BASE_PATH=/`
and add the domain under *Settings → Pages*.

**Api → Render** (`render.yaml`). *Render → New → Blueprint → this
repository*, then fill in the values marked `sync: false`: `WEB_ORIGIN` is
`https://issuerforge.github.io` (scheme and host only — no path), `DATABASE_URL`
is the Supabase **transaction pooler** string (port 6543), and the rest are
the same secrets as in `.env.example`. Render provides `PORT` itself. The free
instance sleeps after 15 minutes of silence; `.github/workflows/keepalive.yml`
pings `/health` every 5 minutes, which the 750 free hours a month cover.
GitHub disables the schedule after 60 days without a commit — re-enable it
under *Actions* if the repository goes quiet.

The indexer (M2) will run inside the api process behind a flag rather than
as a second service: Render's free plan has no background workers.

## What comes next

- **M2 — the order is executed.** Deferred 2-of-N signing (`ActionProposal`,
  revocation window), freeze, seize via `PermanentDelegate`, pause via
  `Pausable`, a mandatory case reference on every action, an indexer, an
  NDJSON journal with an independent verifier, and the compliance officer's
  screens.
- **M3 — the reserve holds.** Continued minting under the attested reserve,
  attestation expiry as a token parameter, the platform fee, a public
  transparency page (Astro) showing circulation, reserve and attestation age.
- **M4 — off-ramp.** Redemption against a fixture partner.

Out of scope on every milestone: real KYC providers, a real bank reserve, a
real off-ramp partner, and mainnet.

## Status

Milestone M1 is closed and measured on devnet. Milestone M2 is next.
