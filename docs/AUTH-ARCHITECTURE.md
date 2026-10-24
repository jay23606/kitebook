# How Kitebook signs people and apps in

Kitebook uses [Better Auth](https://www.better-auth.com) 1.7 (exact versions pinned in `package.json`) for the protocol and keeps the policy itself. Code: `src/auth.ts`; tests: `scripts/auth-e2e.ts` (run by `smoke.sh` under `cf dev` and again on plain workerd).

## The pieces

| Part | Who owns it | Where |
|---|---|---|
| The owner's browser session (30 days, sliding; cookie `kitebook-<acct>.session_token`) | Better Auth | `src/auth.ts` (`mintSession`, `sessionOf`), `src/session.ts` (`sessionOwner`) |
| Passkeys | `@better-auth/passkey` (SimpleWebAuthn underneath) | `/api/auth/passkey/*`; page script `PASSKEY_JS` |
| OAuth 2.1 + PKCE, refresh rotation, RFC 7009 revoke, RFC 8414 / 9728 metadata | `@better-auth/mcp` on `@better-auth/oauth-provider` | `/api/auth/oauth2/*`, `/.well-known/oauth-*` |
| Client ID Metadata Documents (MCP 2026-07-28), with dynamic registration as the fallback | `@better-auth/cimd`; Kitebook's registration rules (`OAUTH_DCR`) in front | `cimdFetch`, `dcrRefusal` |
| Storage | Kysely over the account's Durable Object SQLite (`kysely-durable-objects`) | the account's `Dir` object |
| `kitebook open`, sign-in requests (`kitebook approve <code>`), the recovery code | Kitebook; each ends in a Better Auth session | `src/start.ts`, `src/login.ts`, `src/oauth.ts` (requests) |
| The consent page (3 presets) and the grant | Kitebook | `src/auth.ts` `consent`, `src/oauth.ts` `grant` |
| The live grant check on `/mcp`, `/v1`, the WebSocket and events | Kitebook | `Dir.authJwt` → `authFamily` |
| Runner tokens, signed tasks, payload-bound approvals, the owner-signed Permissions policy, Settings | Kitebook (unchanged) | |

One Better Auth instance lives in each account's `Dir` Durable Object, built on first use: migrations run first (Better Auth checks the schema once per adapter and caches a mismatch), then `betterAuth(...)` from `better-auth/minimal` with an explicit Kysely adapter. The secret is generated once and kept in that object, so a self-hoster configures nothing. The same bundle runs under `cf dev`, on Cloudflare and on plain `workerd serve` with local-disk Durable Objects. The Better Auth stack (Kysely, the plugins, WebAuthn) is reached only through a dynamic import (`src/auth-lib.ts`), so it is parsed into the one bundle file but evaluated on the first sign-in or token check, not on every cold start; Space objects and the front door's other routes never run it. The build is minified (`bun scripts/bundle-size.ts` shows what's inside).

## Owner sign-in: three ways, one session

1. **`kitebook open` on the Mac** (the normal way). The runner asks for a single-use 5-minute link, `/start#login=ll.<acct>.<secret>&trust=<k>`. The page posts the first half once and gets a Better Auth session. `k` stays in the fragment; the browser proves it holds it (HMAC over its P-256 signing key) and the Mac then trusts that browser for Settings changes by itself. Nobody pins a key by hand any more; the old pin command prints where trust happens now.
2. **A passkey**, added in Settings (or on the prompt after updating). Discoverable, so signing in needs no account name on a self-hosted Kitebook.
3. **A sign-in request** as the fallback: the page shows a code; `kitebook approve <code>` on the Mac (or Approve in a browser already signed in) answers it. Nothing goes to the phone for signing in.

The recovery code (made at hosted signup, or the operator's `ADMIN_TOKEN` on root) still starts a session; it is hidden behind "Use a recovery code" and only needed to bootstrap a hosted account before a Mac is connected. Removed: phone sign-in, the separate "remembered browser" cookie (sessions are 30 days and listed in Settings), the hand-rolled WebAuthn and session code.

All three end in `mintSession`: the Dir calls a Better Auth plugin endpoint (`/relay/mint`) in-process with a per-instance secret; `Dir.fetch` refuses that path from outside.

## Apps: CIMD or DCR, Kitebook's consent, a grant checked live

```
app ──401──► /.well-known/oauth-protected-resource/mcp ──► issuer <origin>/api/auth (its metadata at /.well-known/oauth-authorization-server/api/auth)
    ──authorize (PKCE S256)──► signed out? → /start (kitebook open · passkey · sign-in request) → straight back
                             ► signed in → Kitebook's /consent (3 presets) → grant written → Better Auth's /oauth2/consent → code
    ──token──► JWT access token (1 h, aud = <origin>/mcp) + rotating refresh token (30 days, sliding)
    ──/mcp, /v1, /v1/stream, events──► JWT verified against the account's own JWKS in-process, then the grant, on every call
```

- **The grant decides, not the scope string.** The consent page writes a grant (`oauth_families` row: the app's connection, its space, its verbs) linked to a peer with caps, exactly what invites and the device grant make, so Settings, Permissions, events and the Status card work unchanged.
- **Asked every time, unless the app has a grant.** Better Auth's consent memory is switched off: its consent row is deleted as soon as the code is issued, so every authorization comes back to Kitebook's `/consent`. If the app (its client id) has a live grant the owner can see in Settings, `/consent` answers at once with no page; otherwise the owner is asked. Removing the app, its end date passing, or `revoke_self` ends the grant: its access tokens fail the next call, its refresh tokens and Better Auth consent are deleted, its event subscriptions and streams end, and the next connect asks again.
- **One app on two computers (CIMD).** Every installation of a CIMD app shares one client id (its metadata URL). Decision: they share one connection. The second install signs in under the existing grant without a page (the owner already approved that app and can see it in Settings); removing it signs out every install. A DCR app registers per installation, so it gets its own connection. (If separate connections per install are ever needed: put a grant id in the token via `customAccessTokenClaims` keyed by the consent reference.)
- **Registration rules.** `OAUTH_DCR` unset (self-host): public clients returning to loopback http or https, plus confidential clients whose redirects are all on Claude.ai's or ChatGPT's own hosts; `1` or `HOSTED=1`: any valid client (Claude.ai / ChatGPT with a secret); `0`: none. CIMD apps need no registration in any mode. Per-IP limit on registration; self-registered clients never approved are swept.
- **CIMD fetch (SSRF).** Only https on a public host name; localhost/.local/.internal and other internal names, private, loopback, link-local and CGNAT IP literals are refused; every address the name resolves to (DNS over HTTPS) must be public; no redirects; 5 s timeout. A name resolving to localhost (e.g. `localtest.me`) is refused before any fetch; the smoke checks this.

## Hosted Kitebook servers: one issuer per account (decision)

Each account has its own Better Auth (in its own `Dir`), so its own issuer, keys, clients, sessions and tokens:

| | self-host (root account) | hosted account `<a>` |
|---|---|---|
| MCP URL | `<origin>/mcp` | `<origin>/u/<a>/mcp` |
| issuer / OAuth endpoints | `<origin>/api/auth` | `<origin>/u/<a>/api/auth` |
| consent / sign-in page | `/consent`, `/start` | `/u/<a>/consent`, `/u/<a>/start` |
| session cookie | `relay-root.session_token` | `kitebook-<a>.session_token` |

Why not one global auth object: it would be a single hot spot and a single blast radius for every account's keys and sessions, and per-account issuers fall out of the existing per-account `Dir` for free. The cost is a per-account MCP URL on hosted Kitebook servers (the protected-resource metadata can name only one issuer per resource). `/v1` takes the token too; its account comes from the token's issuer, and a token is refused on another account's MCP URL.

## Existing installs

- Apps' tokens from before (`at.`/`rt.`) keep working, refresh included, until the app signs in again (the original token code stays for the device grant).
- An app with an old client id (`rc_…`) at the old authorize or token endpoint gets a plain-words next step: remove its Kitebook connection and add it again; it signs itself up again, and its access stays in Settings until removed.
- Old browser sessions simply sign in again once. Old passkeys can't be carried over (different credential store and user handle): Settings and /start ask once to add it again.
- The smoke runs the previous release on a data folder, then this one on the same data, and checks all of the above.

## Not done yet

- **The device grant** (Hark, runners, `kitebook login --device`) still uses Kitebook's original token format and `/oauth/device_authorization`; it moves to Better Auth's `oauthDeviceAuthorization()` with the same `/device` page later, then the rest of the original token code goes.
- Bundle-size trim: unused Kysely dialects and Better Auth parts could be aliased out.

## Risks

- **Dependency weight and churn:** Better Auth took the Worker from 1,017 KB / 316 KB gzip to 2,315 KB / 582 KB gzip (about +1.3 MB raw, +266 KB gzip) and the 1.7.x line ships often. Versions are pinned exactly; update deliberately with the e2e as the gate.
- **CIMD DNS rebinding:** the address check and the fetch are separate lookups. Cloudflare's network doesn't reach private ranges; on workerd a public-only outbound network in the config closes it (not the default, because self-hosters often keep S3/MinIO on their LAN).
- **Owner email:** Better Auth wants one; the owner is `owner@relay.invalid`, and no email feature is ever enabled.
- **A passkey-only browser** has no `kitebook open` secret, so the Mac doesn't trust it for Settings changes that run on the Mac until it is trusted by click from a trusted browser (unchanged from before).
