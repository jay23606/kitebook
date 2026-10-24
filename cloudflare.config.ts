import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

// deploy-time knobs: KITEBOOK_<NAME>=... cf deploy (RELAY_<NAME>, the name from before the rename, still works)
const E = (k: string) => { const e = (globalThis as any).process?.env ?? {}; return String(e[k] ?? e[k.replace(/^KITEBOOK_/, "RELAY_")] ?? ""); };
// Set only by smoke.sh when it runs `cf dev`; never set it for a deploy.
const EVENTS_TEST = E("KITEBOOK_EVENTS_TEST") === "1";

export default defineConfig({
	worker: {
		name: "relay",
		compatibilityDate: "2026-10-06",
		entrypoint,
		exports: {
			Space: exports.durableObject({ storage: "sqlite" }),
			Dir: exports.durableObject({ storage: "sqlite" }),
		},
		env: {
			SPACE: bindings.durableObject({ worker: "relay", exportName: "Space" }),
			DIR: bindings.durableObject({ worker: "relay", exportName: "Dir" }),
			ADMIN_TOKEN: bindings.secret(),
			// Signed runner releases (client/integrity.ts). A self-hoster with their own release key sets KITEBOOK_RUNNER_RELEASE_KEY=ed25519:...
			// (embedded into install.sh as the key it checks with; empty = client/release-key.ts). KITEBOOK_RUNNER_MANIFEST_SIG: the signature line
			// from scripts/sign-release.ts, if not committed as release/manifest.sig. The server never holds the private key.
			RUNNER_RELEASE_KEY: bindings.text(E("KITEBOOK_RUNNER_RELEASE_KEY")),
			RUNNER_MANIFEST_SIG: bindings.text(E("KITEBOOK_RUNNER_MANIFEST_SIG")),
			BLOBS: bindings.r2({ name: "relay-blobs" }),
			// MCP Events knobs. Only the smoke test sets these (KITEBOOK_EVENTS_TEST=1 when running `cf dev`); a deploy gets the safe defaults:
			// no loopback/http callbacks, 60s TTL floor, 15s stream heartbeat.
			EVENTS_ALLOW_LOOPBACK: bindings.text(EVENTS_TEST ? "1" : "0"),
			EVENTS_MIN_TTL_MS: bindings.text(EVENTS_TEST ? "1000" : "60000"),
			EVENTS_HEARTBEAT_MS: bindings.text(EVENTS_TEST ? "1000" : "15000"),
			// Open streams keep the DO awake, so cap their life (client reconnects with the final cursor) and count per peer.
			EVENTS_STREAM_MAX_MS: bindings.text(EVENTS_TEST ? "6000" : "300000"),
			EVENTS_MAX_STREAMS: bindings.text(EVENTS_TEST ? "3" : "4"),
			// Durable webhook outbox: first retry after OUTBOX_BASE_MS, doubling (jittered, capped 10 min), dropped after OUTBOX_MAX_ATTEMPTS tries.
			OUTBOX_BASE_MS: bindings.text(EVENTS_TEST ? "1000" : "2000"),
			OUTBOX_MAX_ATTEMPTS: bindings.text("8"),
			// Hosted mode: a public Kitebook strangers sign up on (KITEBOOK_HOSTED=1 at deploy). It opens dynamic client registration to every
			// client (unless KITEBOOK_OAUTH_DCR=0) and sets the hosted default quotas below. A self-hosted Kitebook leaves it off.
			HOSTED: bindings.text(E("KITEBOOK_HOSTED") === "1" ? "1" : "0"),
			// Web + API signup for anyone (a public hosted Kitebook): set KITEBOOK_OPEN_SIGNUP=1 when deploying. Off, only the operator's ADMIN_TOKEN
			// creates accounts. /start shows the signup form only when this is "1".
			OPEN_SIGNUP: bindings.text(E("KITEBOOK_OPEN_SIGNUP") === "1" ? "1" : "0"),
			// Signups per IP per hour (operator key exempt). Empty: 5 hosted, 20 otherwise.
			SIGNUP_PER_IP_HOUR: bindings.text(E("KITEBOOK_SIGNUP_PER_IP_HOUR")),
			// Per-account quotas for every account but root (0 = unlimited; empty = the default: hosted 3 spaces / 25 peers / 500 MB per space,
			// else unlimited). The operator overrides one account with: admin.ts quota <account> spaces=5 peers=50 storage_mb=2000
			QUOTA_SPACES: bindings.text(E("KITEBOOK_QUOTA_SPACES")),
			QUOTA_PEERS: bindings.text(E("KITEBOOK_QUOTA_PEERS")),
			QUOTA_STORAGE_MB: bindings.text(E("KITEBOOK_QUOTA_STORAGE_MB")),
			// OAuth 2.1 (src/oauth.ts). Dynamic client registration: empty (default) = public clients with loopback/https redirects sign
			// themselves up (Pi, Codex, Claude Code; registering grants nothing, the owner's consent does), or every client when HOSTED=1;
			// "1" = every client (Claude.ai / ChatGPT may ask for a secret); "0" = off (the owner connects CLIs from /start). Lifetimes in
			// seconds; the smoke test shortens the device code, poll interval, access token and the unused-client sweep (and runs the default).
			OAUTH_DCR: bindings.text(E("KITEBOOK_OAUTH_DCR") === "1" ? "1" : E("KITEBOOK_OAUTH_DCR") === "0" ? "0" : ""),
			OAUTH_DEVICE_TTL: bindings.text(EVENTS_TEST ? "8" : "600"),
			OAUTH_INTERVAL: bindings.text(EVENTS_TEST ? "1" : "5"),
			// kitebook join / kitebook login <url> (src/join.ts): how long a machine's code waits for approval (seconds; the smoke shortens it)
			JOIN_TTL: bindings.text(EVENTS_TEST ? "12" : "600"),
			// A remote-hosted server that starts UNCLAIMED (src/claim.ts): KITEBOOK_CLAIM=1 at deploy. Until the owner's laptop claims it
			// (kitebook login <url>, approved on the server shell or with the KITEBOOK_OWNER_CLAIM secret) it serves only /health and /claim.
			KITEBOOK_CLAIM: bindings.text(E("KITEBOOK_CLAIM")),
			OAUTH_SLOWDOWN: bindings.text(EVENTS_TEST ? "1" : "5"),
			OAUTH_ACCESS_TTL: bindings.text(EVENTS_TEST ? "4" : "3600"),
			// Refresh tokens slide: each use starts a fresh 30 days, so a connector idle for a few weeks still works. OAUTH_GRANT_MAX_TTL caps a
			// grant's total life (0 = no cap; the owner revokes instead).
			OAUTH_REFRESH_TTL: bindings.text(E("KITEBOOK_OAUTH_REFRESH_TTL") || String(30 * 86400)),
			OAUTH_GRANT_MAX_TTL: bindings.text(E("KITEBOOK_OAUTH_GRANT_MAX_TTL") || "0"),
			OAUTH_CLIENT_UNUSED_TTL: bindings.text(EVENTS_TEST ? "3" : "86400"), // registered clients never used are swept after this
			LOGIN_LINK_TTL: bindings.text(EVENTS_TEST ? "6" : "300"), // `kitebook open`: how long its single-use sign-in link works
			OAUTH_CONNECT_TTL: bindings.text(EVENTS_TEST ? "12" : "300"), // "Approve on my phone / Mac": how long one connection request (and its code) lives
			// Storage hygiene (src/space.ts). Empty = the default. Requests per minute per token per space (600; 0 = off), the most seconds a
			// task may be held claimed/approving/running (86400; 0 = off), the event-log cap per space (100000; 0 = off) and the bytes one grep
			// call scans (8 MB). The owner overrides rate and events per space with admin.ts ratelimit / retention.
			RATE_PER_MIN: bindings.text(E("KITEBOOK_RATE_PER_MIN")),
			MAX_HELD_SEC: bindings.text(E("KITEBOOK_MAX_HELD_SEC")),
			EVENTS_MAX: bindings.text(E("KITEBOOK_EVENTS_MAX")),
			GREP_BUDGET_BYTES: bindings.text(E("KITEBOOK_GREP_BUDGET_BYTES")),
			// MCP connector name shown in clients (serverInfo.title). An account's own `title` (admin.ts title <name>) wins for its tokens.
			KITEBOOK_TITLE: bindings.text(E("KITEBOOK_TITLE") || "Kitebook"),
			KITEBOOK_WEBSITE_URL: bindings.text(E("KITEBOOK_WEBSITE_URL") || ""),
			// Knowledge base embeddings (src/kb.ts). Keyword search always works; semantic search needs an embedder: the Workers AI binding
			// (KITEBOOK_KB_AI=1 at deploy; optional KITEBOOK_KB_VECTORIZE=<index name> mirrors vectors into Vectorize), or "off". Smoke uses an offline fake.
			KB_EMBED: bindings.text(EVENTS_TEST ? "fake" : E("KITEBOOK_KB_EMBED") || ""),
			KB_EMBED_MODEL: bindings.text(E("KITEBOOK_KB_EMBED_MODEL") || ""),
			...(E("KITEBOOK_KB_AI") === "1" && !EVENTS_TEST ? { AI: bindings.ai() } : {}),
			...(E("KITEBOOK_KB_VECTORIZE") && !EVENTS_TEST ? { KB_VECTORS: bindings.vectorize({ name: E("KITEBOOK_KB_VECTORIZE") }) } : {}),
		},
		observability: { enabled: true },
	},
});
