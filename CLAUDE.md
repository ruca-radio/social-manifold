# CLAUDE.md — Social Manifold

> Operating manual for Claude Code working in `/home/rucaradio/tori/social-manifold`.
> Read this on every session. Architecture decisions here are load-bearing.

---

## 1. What This Is

**Social Manifold** is a federated MCP-server stack that gives Tori's agentic harness (Hermes, forked from OpenClaw) a unified surface for cross-platform social engagement. It is the connective tissue between marketing agents and the messy reality of social platforms — Discord, Telegram, Reddit, Matrix, Bluesky, Mastodon, Discourse, Facebook (Pages + Groups), and the long tail of legacy forums and untyped chat sites.

The agents speak **intent** (`post_to_community`, `engage_thread`, `seed_discussion`, `dm_persona`). The manifold translates intent into the right backend — REST/GraphQL APIs where they exist and are usable, headless-or-headed browser sessions where they don't.

### What Social Manifold IS

- An orchestrator MCP that exposes intent-level verbs to Hermes
- A federation of platform-specific child MCPs, each owning one platform's auth, rate limiting, and quirks
- A persona/identity layer with per-identity isolation (containers, proxies, browser profiles)
- A token-efficient abstraction over browser automation (verbs, not DOM primitives)
- A telemetry surface for shadowban detection and engagement health

### What Social Manifold IS NOT

- Not a CIB (coordinated inauthentic behavior) tool. We operate in **Bucket 1** (owned channels) and **Bucket 2** (disclosed, transparent automation on platforms that allow it). See §11.
- Not a generic browser-automation framework. We wrap one (Skyvern) — we don't reinvent it.
- Not a scheduler with a fancy UI. Hermes does the orchestration; we do the connective tissue.

---

## 2. North-Star Architecture

```
                         ┌──────────────────────────────┐
                         │         HERMES (Tori)        │
                         │  marketing agent supervisor  │
                         └──────────────┬───────────────┘
                                        │ MCP (intent verbs)
                         ┌──────────────▼───────────────┐
                         │   social-manifold-core MCP   │
                         │  ┌────────────────────────┐  │
                         │  │ Verb Router            │  │
                         │  │ Persona Resolver       │  │
                         │  │ Idempotency Ledger     │  │
                         │  │ Rate-Limit Accountant  │  │
                         │  │ Content Adapter        │  │
                         │  └────────────────────────┘  │
                         └──┬─────┬─────┬─────┬─────┬───┘
                            │     │     │     │     │
              ┌─────────────┘     │     │     │     └──────────────┐
              ▼                   ▼     ▼     ▼                    ▼
    ┌──────────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────────────┐
    │ API-backed MCPs  │  │  HYBRID    │  │ BROWSER    │  │  PERSONA SERVICES  │
    │ discord/telegram │  │  facebook  │  │ skyvern    │  │  vault, proxies,   │
    │ reddit/matrix    │  │  (graph +  │  │ (legacy    │  │  fingerprint store │
    │ bluesky/mastodon │  │   browser) │  │  forums,   │  │                    │
    │ discourse/etc.   │  │            │  │  chats)    │  │                    │
    └──────────────────┘  └────────────┘  └────────────┘  └────────────────────┘
```

Three rules govern this diagram:

1. **Hermes never speaks platform-specific.** It only calls intent verbs on the core MCP.
2. **Each child MCP owns its platform end-to-end** — auth, rate limits, retries, idempotency, content shaping. The core does NOT leak platform concerns upward.
3. **Backend choice is encapsulated in the child.** Hermes doesn't know whether `mcp-facebook` used the Graph API or drove a browser. The child decides per-action.

---

## 3. Directory Layout

```
/home/rucaradio/tori/social-manifold/
├── CLAUDE.md                          ← this file
├── README.md                          ← human-facing overview
├── docker-compose.yml                 ← top-level orchestration
├── .env.example
├── pnpm-workspace.yaml                ← TS/Node packages
├── pyproject.toml                     ← Python packages (uv)
│
├── packages/
│   ├── core/                          ← orchestrator MCP (TypeScript)
│   │   ├── src/
│   │   │   ├── server.ts              ← MCP server entrypoint
│   │   │   ├── verbs/                 ← intent-verb implementations
│   │   │   ├── router/                ← platform routing logic
│   │   │   ├── persona/               ← persona resolution
│   │   │   ├── idempotency/           ← deduplication ledger
│   │   │   ├── ratelimit/             ← shared rate-limit accountant
│   │   │   └── adapter/               ← content shaping per platform
│   │   └── package.json
│   │
│   ├── child-discord/                 ← discord.js, bot-only
│   ├── child-telegram/                ← gramjs (MTProto) + Bot API
│   ├── child-reddit/                  ← snoowrap, OAuth2
│   ├── child-matrix/                  ← matrix-js-sdk
│   ├── child-bluesky/                 ← @atproto/api
│   ├── child-mastodon/                ← masto.js
│   ├── child-discourse/               ← REST, per-instance config
│   ├── child-facebook/                ← Graph API + Skyvern fallback
│   └── child-browser-generic/         ← Skyvern-backed for the long tail
│
├── services/
│   ├── skyvern/                       ← submodule or vendored
│   ├── persona-vault/                 ← sops+age encrypted credential store
│   ├── proxy-manager/                 ← mobile/residential pool allocator
│   └── telemetry/                     ← OTel collector + Loki/Grafana
│
├── personas/                          ← per-persona configs (gitignored, sops-encrypted)
│   └── _example/
│       ├── identity.yaml
│       ├── credentials.sops.yaml
│       └── browser-profile/           ← mounted into Skyvern container
│
├── ops/
│   ├── local/                         ← runbook for the co-located host (start/stop, persona rotation)
│   ├── compose/                       ← per-environment overrides
│   └── runbooks/                      ← incident response, persona rotation
│
└── tests/
    ├── unit/
    ├── integration/                   ← against staging accounts only
    └── shadow-detection/              ← regression tests for ban signatures
```

**Why TypeScript for MCP, Python for orchestration-adjacent work:** Anthropic's MCP SDK is most mature in TS. The platform SDKs (discord.js, gramjs, atproto) are TS-first. Python earns its keep for ML-adjacent persona-behavior modeling and for anything where Patrick already has CloudOne tooling in Python.

---

## 4. Intent Verb Catalog (Core MCP)

These are the verbs Hermes calls. Keep this list **small and semantic**. Resist the urge to add platform-specific verbs to the core.

| Verb | Description | Required params |
|------|-------------|-----------------|
| `post_to_community` | Publish original content to a named community/channel | `persona_id`, `community_ref`, `content`, `media?` |
| `reply_to_thread` | Respond within an existing thread | `persona_id`, `thread_ref`, `content` |
| `engage_thread` | React/upvote/bookmark without text | `persona_id`, `thread_ref`, `engagement_type` |
| `dm_persona` | Send a direct message | `persona_id`, `recipient_ref`, `content` |
| `seed_discussion` | Post + cross-link to drive a coordinated launch (audited; see §11) | `persona_id`, `community_refs[]`, `content_variants[]` |
| `monitor_mentions` | Stream mentions/replies for a persona | `persona_id`, `since?` |
| `enumerate_communities` | List communities a persona has access to | `persona_id`, `platform?` |
| `health_check_persona` | Run shadowban/rate-limit diagnostics | `persona_id` |

Every verb returns a `VerbResult` with `{status, platform_response_id, idempotency_key, telemetry_span_id, warnings[]}` plus optional extension fields. Children may set `platform_rate_limit: { retry_after_seconds: number }` when the underlying platform returns a rate-limit signal (e.g. Discord 429); the core's rate-limit accountant uses this to record backoff. Other optional extensions are added as needed; readers must treat unknown fields as opaque.

**`community_ref` and `thread_ref` are universal references** — `platform://identifier` URIs that the router resolves. Examples:
- `discord://guild:123456789/channel:987654321`
- `reddit://r/selfhosted/comments/abc123`
- `forum://forum.example.com/threads/42`
- `facebook://group:11111/post:22222`

---

## 5. Per-Platform Backend Strategy

This is the operational truth-table. Update it when platforms change their stance, not before.

| Platform | Primary Backend | Fallback | Notes |
|----------|----------------|----------|-------|
| Discord | Bot API (discord.js) | None | Bot only — selfbots are ToS violation, do not implement. Limit to guilds where bot is invited. |
| Telegram | Bot API for channels we own; MTProto (gramjs) for personal-account flows | None | MTProto is gray-area-tolerated. Use only where bot model can't satisfy the use case. |
| Reddit | OAuth2 (direct REST via `undici`) | None | snoowrap last released 2022-06; snoots stuck in pre-1.0 since 2023. Both predate Reddit's 2023 API changes and are unsafe to depend on. Honor per-subreddit rules. Throttle aggressively — Reddit's 2023 pricing made the API unforgiving. |
| Matrix | matrix-js-sdk, application service or bot user | None | Cleanest API in the stack. |
| Bluesky | @atproto/api | None | Open protocol, low friction. |
| Mastodon | masto.js, per-instance OAuth | None | Per-instance — the manifold tracks instance-specific creds. |
| Discourse | REST API, per-instance API key | Skyvern | Many self-hosted Discourse installs have non-standard auth. |
| Facebook Pages | Graph API | Skyvern | Pages we own only. |
| Facebook Groups | **Skyvern (browser-only)** | None | Groups API was killed Q1 2024. Browser is the ONLY path. Read §7 carefully. |
| Legacy forums (phpBB, vBulletin, XenForo) | Skyvern with per-engine selectors | None | Build a selector library; expect rot. |
| "Non-descript chat sites" | Skyvern with vision-augmented action | Manual handoff | Vision LLM picks elements when DOM is unstable. |
| LinkedIn | **Out of scope for v1** | — | High detection risk, low ROI for our use cases. Revisit later. |
| X/Twitter | Out of scope for v1 unless paid tier acquired | — | API pricing makes it not worth integrating in early phases. |
| Instagram | Out of scope for v1 | — | Graph API restrictions on personal posting; revisit if business need emerges. |

---

## 6. Persona Layer (Identity Isolation)

A persona is the unit of identity. Each persona maps to:

- A unique container (where browser-backed actions originate)
- A dedicated browser profile (cookies, localStorage, IndexedDB persisted to a volume)
- A sticky proxy assignment (mobile preferred; residential acceptable; datacenter forbidden)
- A credential bundle (per-platform tokens, encrypted at rest)
- A behavior profile (timezone, locale, posting cadence, working hours, vocabulary fingerprint)

**Persona identity rules:**

1. **One persona per real-world identity for owned channels.** If Patrick is the principal, his Discord/Reddit/etc. credentials live under one persona.
2. **Bot/branded personas are allowed where platforms permit.** Disclosed automation accounts (bots flagged as such, branded service accounts) are first-class.
3. **Sockpuppet creation is forbidden.** No automated mass-account creation, no fake-human personas posing as organic users. This is the Bucket 3 line — see §11.
4. **Persona retirement is normal.** Accounts get flagged. Build for replacement, not permanence. Track "persona lifetime" metrics; rotate before signals degrade.

### Persona config schema (`personas/<id>/identity.yaml`)

```yaml
id: persona_alpha
display_name: "Alpha Operator"
type: branded_bot                  # one of: principal | branded_bot | service_account
timezone: America/New_York
locale: en-US
working_hours: "09:00-22:00"
posting_cadence_minutes: [12, 45]   # min/max gap between actions
proxy_pool: mobile_us_east
browser_profile_path: ./browser-profile
disclosed_automation: true          # MUST be true for any persona using API automation on platforms that require disclosure
platforms:
  discord:
    enabled: true
    credential_ref: discord_token
  reddit:
    enabled: true
    credential_ref: reddit_oauth
  facebook:
    enabled: false                  # explicit opt-in per platform
```

### Credentials

- All credentials live in `personas/<id>/credentials.sops.yaml`, encrypted with `age` keys.
- Decryption happens **only inside the running container**, never on disk in the clear.
- Persona vault service is the only component allowed to read credentials. It exposes a request/response API to children, never bulk-dumps.

### Persona container hardening (co-located deployment)

Because the manifold runs on the same host as Hermes, persona
containers receive additional hardening beyond standard Docker
defaults:

- `read_only: true` on the container filesystem. Writable paths are
  declared explicitly as tmpfs or named volumes (browser profile,
  Skyvern's scratch dir).
- `cap_drop: [ALL]` then add back only what Chromium needs
  (`SYS_ADMIN` is required for sandboxing; document the why in the
  compose comments).
- `security_opt: [no-new-privileges:true]`.
- No `--privileged`. Ever.
- The container's user is non-root, UID/GID matched to the persona's
  profile directory ownership on the host.
- `tmpfs` for `/tmp` with `noexec,nosuid` to limit drive-by exploit
  utility.

These are baseline. Skyvern's own container hardening (per its
upstream docs) layers on top. If Skyvern's defaults conflict with
any of the above, the manifold's settings win — open an issue,
don't silently relax.

---

## 7. Browser Layer (Skyvern Integration)

Skyvern is vendored under `services/skyvern` (preferably as a git submodule pinned to a specific tag — pin and bump deliberately, do not float).

### Why Skyvern over rolling our own

- AI-augmented Playwright with vision LLM fallback when selectors fail
- Docker Compose first; matches our deployment model
- Active project; non-trivial selector library already built
- Lets us focus on the manifold, not on browser plumbing

### Container topology (per persona)

```
persona_<id>_browser
├── Skyvern worker container
│   ├── Chromium (Playwright-managed, persistent context)
│   ├── Browser profile volume (./personas/<id>/browser-profile)
│   ├── Proxy egress: routes through proxy-manager → assigned mobile/residential exit
│   └── Fingerprint config: matches identity.yaml (timezone, locale, viewport)
└── Health probe sidecar (reports session liveness, captcha encounters)
```

### Browser MCP exposure

Children that wrap Skyvern do NOT expose Playwright primitives to Hermes. They expose **task verbs**:

```typescript
// child-facebook/src/skyvern-tasks.ts — examples
async fbGroupPost(personaId: string, groupId: string, content: string, media?: Media[]): Promise<TaskResult>
async fbGroupGetPost(personaId: string, groupId: string, postId: string): Promise<Post>
async fbGroupListJoined(personaId: string): Promise<Group[]>
```

Skyvern's natural-language task interface is acceptable internally, but the **outward contract** to the core MCP is structured.

### Stealth posture

Detection is tightening. Build with the assumption that defaults are detected.

- **No vanilla Playwright.** Use Camoufox or patched Playwright with Patchright.
- **No headless mode for production work.** Run headed inside Xvfb. Xvfb adds ~50MB; the detection delta is worth it.
- **TLS fingerprinting matters.** Where the child makes HTTP calls outside the browser, use `curl_cffi` (Python) or `node-curl-impersonate` (TS) — not stock fetch/axios.
- **Behavioral entropy.** Inject randomized cursor paths, scroll velocity, dwell times. Skyvern has hooks for this; use them.
- **Mobile proxies for protected platforms.** Datacenter IPs fail before TLS completes on Cloudflare/DataDome/Akamai-protected sites.
- **Fingerprint consistency.** Timezone in JS must match IP geolocation. Audio/canvas/WebGL fingerprints must be stable per persona, varied across personas. Use a fingerprint generator (e.g., fingerprint-suite) seeded by persona ID.

### Captcha handling

Three-tier policy:

1. **Tier 1 — Try not to trigger them.** Stealth posture + behavioral entropy + warmed sessions.
2. **Tier 2 — Solver service for low-stakes.** 2Captcha/CapSolver for image/recaptcha when triggered. Budget per persona; alert on overage.
3. **Tier 3 — Human handoff for high-stakes.** Skyvern's live-view URL + a Slack/Discord notification to the operator. Persona pauses; resumes after manual solve.

---

## 7.5. Co-location Topology and Trust Boundaries

Social Manifold runs on the same host as Hermes (Patrick's main production
machine), not on dedicated Proxmox infrastructure. This is a deliberate
operational choice — lower coordination overhead, shared observability,
no cross-host network — but it raises the bar on internal isolation.
Co-location does not collapse trust boundaries; it makes them
software-enforced rather than infrastructure-enforced.

### Trust zones on the host

```
┌─────────────────────────────────────────────────────────────────┐
│ HOST (Patrick's production box)                                 │
│                                                                 │
│  ┌───────────────────┐         ┌─────────────────────────────┐  │
│  │ Hermes (Tori)     │  Unix   │ social-manifold-core        │  │
│  │ marketing agents  │◄───────►│ + API-backed child MCPs     │  │
│  │                   │  socket │ (discord, telegram, reddit, │  │
│  └───────────────────┘         │  matrix, bluesky, mastodon, │  │
│         ZONE A                 │  discourse)                 │  │
│                                └──────────────┬──────────────┘  │
│                                               │ docker network: │
│                                               │ manifold_core   │
│                                               ▼                 │
│                                ┌─────────────────────────────┐  │
│                                │ persona_<id>_browser × N    │  │
│                                │ (Skyvern + Chromium per     │  │
│                                │  persona)                   │  │
│                                │                             │  │
│                                │ docker network:             │  │
│                                │ manifold_browser_isolated   │  │
│                                │ (no route to Zone A or B)   │  │
│                                └──────────────┬──────────────┘  │
│                                               │                 │
│                                               ▼                 │
│                                ┌─────────────────────────────┐  │
│                                │ proxy-manager               │  │
│                                │ (egress-only gateway)       │  │
│                                └──────────────┬──────────────┘  │
│                                               │                 │
└───────────────────────────────────────────────┼─────────────────┘
                                                ▼
                                     mobile/residential proxy
                                       → public internet
```

**Zone A — Hermes.** Marketing agents, LLM inference, agent state.
Holds persona IDs only.

**Zone B — Manifold control plane.** Core MCP, API-backed child MCPs,
persona vault, idempotency ledger, telemetry collector. Holds credentials
(decrypted only in-memory inside child MCPs that need them, never on disk
in the clear, never returned to Zone A).

**Zone C — Persona browsers.** One container per persona. Holds active
browser sessions, cookies, profile data. Treated as semi-trusted —
they execute against the open internet, sometimes load adversarial
content, and can encounter captcha-solver injections. Worst-case
compromise of a browser container must not reach Zone A or other
personas.

### Hermes ↔ Manifold transport: Unix domain socket

Because Hermes and the core MCP share a host:

- Bind core MCP to `/run/social-manifold/core.sock` (mode 0660).
- Group ownership shared between the Hermes process user and the manifold
  process user. No TCP listener.
- No bearer token on the socket — filesystem permissions are the auth.
- TCP listener may be added later if a remote Hermes ever consumes the
  manifold; not in v1.

`packages/core/src/server.ts` reads `SOCIAL_MANIFOLD_TRANSPORT` from env:
- `unix:///run/social-manifold/core.sock` (default, production)
- `tcp://127.0.0.1:7801` (development convenience only)

### Core ↔ child MCP transport: Unix domain socket (recursive)

Children are MCP servers (per §2 rule 2 — "Each child MCP owns its platform
end-to-end"). The transport between core and each child mirrors the
Hermes ↔ core link, applied recursively:

- Each child binds an MCP server to `/run/social-manifold/children/<name>.sock`
  (mode 0660, group `social-manifold`). E.g. `discord.sock`, `telegram.sock`.
- Core acts as an **MCP client** to each child (and an MCP server to Hermes).
  No HTTP-RPC, no bespoke RPC.
- Same socket-perms-as-auth model: filesystem permissions enforce trust.
- The router in core resolves URI schemes (e.g. `discord://...`) to the
  matching child MCP client connection. Child MCPs expose their verb
  surface as MCP tools (e.g. `post_to_community`); core forwards calls.

Why MCP-as-transport everywhere, not internal HTTP-RPC:
- Protocol uniformity across the federation: every child looks the same
  to core; new children plug in without bespoke clients.
- MCP tool listing gives free child-capability discovery.
- Streaming verbs (Discord gateway, Telegram updates, Matrix sync) get
  MCP's notification/subscription model without a transport rewrite.
- Service-to-service MCP traffic carries no LLM context — the token-
  overhead concerns that apply to MCP-in-LLM-context do not apply here.

The directory `/run/social-manifold/children/` is created by
`scripts/setup-runtime-dir.sh` (same mode/group as the parent).

**Client lifetime is process-lifetime.** `StreamableHTTPServerTransport`
is single-session per server instance. The core establishes one MCP
client per child at startup and reuses it for all calls. Per-request
client construction will fail with "Server already initialized." This
constrains future patterns — any "spawn-on-demand child" or "isolated
client per test" design must either run one server-instance-per-client
or use a different transport. Surfaced and confirmed during Plan 4
integration testing (PR #3).

### Network isolation rules (non-negotiable)

1. **Persona browser containers run on a dedicated Docker bridge
   network (`manifold_browser_isolated`)** with `internal: true` set
   in compose, plus an explicit one-way route to the proxy-manager
   container. They have **no** route to Zone A (Hermes) or Zone B
   peers (other persona containers, core MCP, vault).

2. **All persona browser egress goes through proxy-manager.** Direct
   internet egress from persona containers is prohibited at the Docker
   network level, not just by convention. If proxy-manager is down,
   persona containers cannot make outbound requests — this is the
   intended behavior.

3. **DNS resolution for persona containers does NOT use the host
   resolver.** Each persona's DNS goes through its assigned proxy or
   a per-persona resolver matched to the proxy's exit geolocation.
   Mismatched DNS-vs-IP geolocation is a known persona-fingerprinting
   vector and an instant flag on Cloudflare/DataDome-protected sites.
   Configure `dns:` in compose per-persona, do not inherit from host.

4. **Filesystem mounts are minimum-necessary.** A persona container
   mounts ONLY its own `personas/<id>/browser-profile/` directory.
   No host paths, no other personas' directories, no shared scratch
   space.

5. **Resource limits are explicit.** Each persona browser container
   declares `mem_limit`, `cpus`, and `pids_limit` in compose. A
   runaway browser process must not be able to starve Hermes
   inference scheduling on the shared host.

### Egress accounting

The proxy-manager logs every outbound request from every persona
container. Egress IP must match the persona's assigned proxy exit.
Mismatch triggers immediate persona quarantine (see §6). On the
co-located host this check is doubly important — there is no
network-level firewall between persona containers and the proxy-manager
beyond Docker's bridge isolation, so application-layer accounting is
the durable enforcement point.

---

## 8. Proxy & Network Strategy

Proxies are not optional. They are persona-affinity infrastructure.

- **Mobile proxies (preferred):** 4G/5G residential, sticky sessions per persona for at least 24h. Providers: SmartProxy, Soax, IPRoyal mobile pools. Configure rotation only on persona retirement.
- **Residential proxies (acceptable):** For lower-stakes platforms or read-only operations. Sticky sessions still required.
- **Datacenter proxies (forbidden):** Do not use for any social platform action. Acceptable only for outbound calls to neutral infrastructure (e.g., LLM APIs, internal services).
- **Direct egress (Patrick's home IP):** Forbidden for personas. Operator/admin actions only.

Proxy assignment is sticky to persona, recorded in `personas/<id>/identity.yaml`, and enforced by the proxy-manager service. Every outbound request from a persona container routes through its assigned exit. Leak detection is part of the health probe — if a persona's egress IP is ever observed differing from its assignment, that persona is **immediately quarantined**.

---

## 9. Idempotency, Rate Limiting, Observability

### Idempotency

Every verb call carries an `idempotency_key`. The core MCP maintains a SQLite ledger (or Postgres if scale demands) of seen keys → platform response IDs, with a 7-day TTL. Re-issued verbs return the original response without re-executing on the platform. This is non-negotiable: Hermes will retry, and we cannot double-post.

### Rate limiting

Two layers:

1. **Per-platform global limit** — respect platform-published limits (Discord's 50 msg/sec, Reddit's per-OAuth-app, etc.). Implement as a token bucket per platform per credential.
2. **Per-persona behavioral limit** — derived from `posting_cadence_minutes` in identity.yaml. Even if the platform allows more, the persona doesn't.

The persona limit is the binding constraint. **The core enforces both layers before forwarding any call to a child** — children never see a rate-limited request. Children surface platform-observed rate limits (e.g. Discord 429) back to the core via `VerbResult.platform_rate_limit` (see §4); the core's accountant records these to inform future per-persona backoff decisions. The two-way model: core gates outbound calls; children report observed pushback inbound.

### Observability

OpenTelemetry traces from Hermes verb call → core router → child MCP → platform response. Span attributes include `persona_id`, `platform`, `verb`, `idempotency_key`. Sensitive content goes in encrypted side-tables, not span attributes.

Metrics that matter:

- Verb success rate by platform and persona
- Engagement-per-post (impressions in / replies / reactions out)
- **Engagement-floor anomaly:** if a persona's posts succeed (200 OK) but receive zero engagement for >N posts, flag possible shadowban
- Captcha encounter rate per persona
- Proxy egress consistency
- Persona warmup score (cookie age, history depth, cross-session continuity)

Stack: OTel collector → Loki/Tempo → Grafana. Patrick has Grafana muscle memory; don't introduce a competing stack.

---

## 10. Build, Run, Test

### Prerequisites

- Docker Engine ≥ 24, Docker Compose v2
- Node.js 20.x via `mise` or `volta`
- pnpm 9.x
- Python 3.12 + `uv`
- `sops` and `age` for credential encryption

### First-time setup

```bash
cd /home/rucaradio/tori/social-manifold
cp .env.example .env
# edit .env: set AGE_KEY_PATH, PROXY_MANAGER_TOKEN, etc.

# install workspace dependencies
pnpm install
uv sync

# initialize Skyvern submodule
git submodule update --init --recursive
(cd services/skyvern && docker compose build)

# create example persona (interactive)
pnpm run persona:create --id persona_alpha
```

### Running locally

```bash
# bring up the full stack
docker compose up -d

# tail core MCP logs
docker compose logs -f core

# run a verb manually for testing
pnpm --filter @social-manifold/core verb:invoke \
  --verb post_to_community \
  --persona persona_alpha \
  --community 'discord://guild:.../channel:...' \
  --content 'hello world'
```

### Testing

```bash
# unit tests across all packages
pnpm test

# integration tests (use staging credentials only — see tests/README.md)
pnpm test:integration

# shadow-detection regression suite
pnpm test:shadow-detection
```

**Never run integration tests with production persona credentials.** Staging personas live under `personas/_staging_*` and are clearly marked.

### Deployment (production)

Social Manifold runs on Patrick's main production host alongside Hermes.
There is no separate deployment target.

- Bring up the stack with `docker compose up -d` from the project root.
- The compose file declares three Docker networks:
  - `manifold_core` — core MCP, API-backed children, persona vault,
    telemetry. Internal only.
  - `manifold_browser_isolated` — persona browser containers and
    proxy-manager. `internal: true`. No route to `manifold_core`.
  - `manifold_egress` — proxy-manager only, this is the single network
    with external connectivity.
- Hermes connects to core MCP via Unix socket at
  `/run/social-manifold/core.sock`. The compose service for `core`
  mounts `/run/social-manifold/` from the host with appropriate
  group permissions.
- Skyvern workers run as containers on `manifold_browser_isolated`,
  one container per active persona. They do not require GPU
  passthrough. Patrick's GPU resources remain dedicated to inference
  workloads (Hermes / local LLMs).
- Resource ceilings: each persona browser container is capped at
  2 GB RAM and 1 CPU by default. Adjust per-persona in
  `personas/<id>/identity.yaml` under `resources:` if a specific
  persona's workload demands more.

`ops/local/runbook.md` covers start, stop, persona rotation, log
extraction, and recovery from a host reboot. There is no
`ops/proxmox/` directory in this project.

---

## 11. Hard Constraints & The Bucket Line

This section is load-bearing. If a feature request crosses these lines, **stop and surface the conflict** rather than implementing it.

### What we build (Bucket 1 + Bucket 2)

- **Owned channels:** Patrick's accounts, CloudOne brand accounts, Tori-owned communities. Full automation acceptable.
- **Disclosed bots:** Branded bots that platforms recognize as bots. Bot badges visible. Identifies as automated where ToS requires.
- **Engagement tooling on the operator's behalf:** Replying to mentions, syndicating Patrick's content, running community management for communities Patrick owns or is trusted to manage.

### What we do NOT build (Bucket 3)

- **Sockpuppets.** No automated creation of fake-human accounts. No automation of accounts that misrepresent themselves as organic when they are not.
- **Coordinated inauthentic behavior.** No multi-persona swarms posing as independent users to manufacture consensus, inflate engagement, or simulate organic momentum.
- **Mass duplicate posting.** Posting near-identical content across many communities the operator does not own — even with spintax — drifts toward CIB. The `seed_discussion` verb has a built-in audit log and operator-confirmation gate; do not remove it.
- **Engagement farming.** Automated reactions/likes/upvotes from personas not actually engaging with content.
- **Platform ToS violations as a default mode.** Specific exceptions (e.g., Telegram MTProto for personal-account use) are documented and limited; do not generalize them.

### Why this matters operationally, not just ethically

Bucket 3 work fails. Detection is improving faster than evasion. LLM-driven traffic is now its own detection class. Browser-Use's analysis (their custom Chromium fork exists for a reason) is the right read of the trajectory: *the only reason most automation still works is that detection vendors keep thresholds conservative to avoid false positives*. When AI-agent traffic crosses platforms' tolerance threshold, the screws tighten. Building Bucket 3 features now means building for a window that closes.

Bucket 1/2 work is durable. Build that.

### When in doubt

If a feature request is ambiguous, the test is: **could a reasonable platform trust & safety team look at this and recognize it as legitimate use?** If yes, build it. If no, escalate to Patrick before writing code. This is the "learn to question" clause from his preferences applied to design decisions.

---

## 12. Critical Thinking Mandate

Three operational rules borrowed directly from how Patrick wants to be worked with:

1. **Question the assumption.** When a platform SDK says "use this method," verify it still works. SDKs lag platform reality. Test against the live platform with a throwaway account before integrating.
2. **There is always a fix.** When a platform breaks an integration, the answer is not "this can't be done" — it's "what backend strategy now applies?" Re-run the API/Hybrid/Browser decision for that platform. Update §5.
3. **Don't pattern-match to the familiar.** "It's just like Discord" is almost always wrong. Each platform's failure modes are specific. New child MCPs start with a 2-week observation phase against a staging account before being declared production-ready.

---

## 13. Resolved Decisions (was: Open Questions)

Resolved during Plan 1 review. Update this section if any decision changes.

- **Persona vault:** sops+age. File-based, version-controllable, no additional service to maintain. Revisit if a second operator joins or a regulated workload is added.
- **Manifold owns persona context.** Hermes references personas by `persona_id` only. Hermes never holds credentials, proxy assignments, or browser-profile paths. This is a trust-boundary decision, not a convenience decision — see §7.5.
- **Proxy provider:** TBD. Mobile pool, sticky-per-persona ≥ 24h. Patrick to choose between SmartProxy / Soax / IPRoyal mobile based on pricing and pool quality. Default placeholder in `.env.example` until decided.
- **Telemetry retention:** 31 days hot (Loki default), 180 days cold (compressed archive in object storage). Persona behavioral baselines need the longer window.
- **Persona warmup automation:** hand-roll. Multilogin and equivalent commercial stacks are revisitable if persona attrition becomes the bottleneck.
- **Hermes ↔ Manifold transport:** Unix domain socket (host-local). See §7.5.

---

## 14. Glossary

- **Tori:** Patrick's project; an OpenClaw fork that this manifold serves.
- **Hermes:** The agentic harness inside Tori that orchestrates marketing agents.
- **Persona:** A unit of identity with isolated credentials, container, proxy, and browser profile.
- **Verb:** An intent-level action the core MCP exposes to Hermes.
- **Child MCP:** A platform-specific MCP server that the core routes to.
- **Bucket 1 / 2 / 3:** Use-case classification. 1 = owned channels. 2 = disclosed automation. 3 = CIB / sockpuppet / engagement farming. We build 1 and 2.
- **Skyvern:** Open-source AI-augmented Playwright wrapper; our browser layer.
- **CIB:** Coordinated Inauthentic Behavior — the term-of-art platforms use for the behavior we don't build.

---

## 15. First Build Order

Suggested implementation sequence for v1. Adjust if Patrick prioritizes differently.

1. Skeleton: monorepo, docker-compose, core MCP server with one stub verb (`post_to_community` → echo)
2. Persona vault service + one staging persona
3. `child-discord` (easiest API; bot model; clean test path)
4. Idempotency ledger + rate-limit accountant
5. `child-reddit` (second-easiest; expands content-adapter testing)
6. Telemetry stack (OTel → Loki/Tempo/Grafana)
7. Skyvern integration + `child-browser-generic` for one legacy forum target
8. `child-telegram` (Bot API first, MTProto only if needed)
9. `child-facebook` Pages flow (Graph API)
10. `child-facebook` Groups flow (Skyvern)
11. Health/shadowban probe service
12. `child-matrix`, `child-bluesky`, `child-mastodon`, `child-discourse` (parallelizable)
13. Persona warmup automation
14. `seed_discussion` verb with audit log + operator gate

Each step ships behind a feature flag in core. Hermes only sees verbs that are flagged ready.

---

*End of CLAUDE.md. Update this file when architecture changes — do not let it drift.*
