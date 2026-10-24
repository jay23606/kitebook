# Deferred work ideas (maintainer notes)

**This is historical planning material, not a call for contributions.** These ideas were drafted against `dev` on 2026-10-21 and may be outdated. Current issue discussions and the [contribution guide](../../CONTRIBUTING.md) take precedence. Do not file or implement these ideas without maintainer agreement.

The technical notes below are retained for future prioritization. They are not assigned work, release commitments or approved implementation plans. The original filename is kept so existing links continue to resolve.

Sizes: **XS** under an hour, **S** an afternoon, **M** a day or two; these are historical estimates, not deadlines.

---

### 1. Smoke: cover the runner's `autoFastForward`
**Labels:** `tests`, `runner` · **Size:** S
```markdown
**What:** `client/runner-mirror.ts` fast-forwards a project checkout that is clean and only *behind* its upstream when `autoFastForward` is true in runner.json (global or per project; default off). No test covers it.

**Where:** `client/runner-mirror.ts` (top comment, the `autoFastForward` branch around line 41), `smoke.sh` (the mirror / `code_status` section; copy how it makes a bare upstream with `git init --bare`).

**Done when:** four smoke checks pass: a clean, behind-only checkout fast-forwards; a dirty one doesn't; one that is ahead doesn't; and with the setting off (the default) nothing moves.

Definition of done: `bun run typecheck` clean, `SKIP_NTFY=1 ./smoke.sh` ends in ALL PASSED, PR against `dev`.
```

### 2. Test the S3 blob driver against MinIO
**Labels:** `tests`, `server` · **Size:** S-M
```markdown
**What:** README "Not built yet": the S3 blob store (`BLOB_STORE=s3`, signed with `aws4fetch`) has never run against a real bucket. MinIO in Docker is a free local stand-in.

**Where:** `src/blobs.ts`, `docs/storage.md`, and a new opt-in script (`scripts/s3-smoke.sh`, or a `smoke.sh` section that is skipped unless `S3_ENDPOINT` is set).

**Done when:** with MinIO running, a write over 1 MB lands as `blobs/<sha256>`, reads back byte-identical, and blob GC removes it after the grace period. `docs/storage.md` says how to run it.

Definition of done: `bun run typecheck` clean, the new script passes against MinIO, `npm run test:fast` still passes, PR against `dev`.
```

### 3. `kitebook help <op>`: show one op's parameters
**Labels:** `cli` · **Size:** XS-S
```markdown
**What:** `kitebook ops` lists every op, but seeing one op's parameters means reading `src/ops.ts` or `/openapi.json`. `kitebook help` with no argument already prints the general help (`client/cli.ts`, line ~164).

**Where:** `client/cli.ts`; the descriptions and parameters already exist in `src/ops.ts` and are served at `<kitebook>/openapi.json`.

**Done when:** `kitebook help task_create` prints the description and each parameter with its type and whether it's required; `kitebook help nope` exits 1 and suggests the closest op names. Add a smoke check for both.

Definition of done: `bun run typecheck` clean, `npm run test:fast` passes, PR against `dev`.
```

### 4. `admin.ts help` prints the full usage
**Labels:** `cli` · **Size:** XS
```markdown
**What:** `bun client/admin.ts` with no command prints a one-line list of command names and exits 2. The real usage, with every argument, is only in the comment at the top of `client/admin.ts`.

**Where:** `client/admin.ts` (the header comment and the `usage:` line around line 71).

**Done when:** `bun client/admin.ts`, `--help` and `help` print the full usage (generated from the header comment, so the two can't drift) and exit 0; an unknown command prints it and exits 1. Add a smoke check.

Definition of done: `bun run typecheck` clean, `npm run test:fast` passes, PR against `dev`.
```

### 5. Use an index for `kb_list key_prefix`
**Labels:** `kb`, `server` · **Size:** S
```markdown
**What:** `kb_list` filters `key_prefix` with `substr(key,1,?)=?` (`src/kb.ts`, line ~165), which SQLite can't serve from an index, so it scans every KB row.

**Where:** `src/kb.ts` and the KB table schema (`src/kb.ts` / `src/space/kb.ts`).

**Done when:** the filter is a range (`key >= ? AND key < ?`, upper bound = prefix + U+10FFFF) or an escaped `GLOB 'prefix*'`, there's an index on `key` if there isn't one, `EXPLAIN QUERY PLAN` shows it used (paste it in the PR), and the existing KB smoke checks still pass.

Definition of done: `bun run typecheck` clean, `SKIP_NTFY=1 ./smoke.sh` ends in ALL PASSED, PR against `dev`.
```

### 6. Webhooks: suspend on failure rate, not only 20 failures in a row
**Labels:** `server` · **Size:** S
```markdown
**What:** an event subscription is suspended after `EVENTS_SUSPEND_AFTER` (default 20) *consecutive* failed deliveries (`src/space/events.ts`, line ~93). A destination that fails every other time is never suspended, and verification POSTs have no per-host rate limit.

**Where:** `src/space/events.ts` (delivery, `fails`, `active`), `docs/agents.md` (MCP Events section).

**Done when:** a subscription is also suspended when its failure rate over a sliding window passes a documented threshold, verification POSTs are rate-limited per destination host, and a smoke test with a flaky local receiver shows it suspended and then reactivated by a refresh.

Definition of done: `bun run typecheck` clean, `SKIP_NTFY=1 ./smoke.sh` ends in ALL PASSED, PR against `dev`.
```

### 7. MCP: optional strict `Mcp-Name` header check
**Labels:** `mcp` · **Size:** XS
```markdown
**What:** on `events/*` requests a missing `Mcp-Name` header is tolerated and only a mismatch is rejected (`src/mcp.ts`, the SEP-3415 comment around line 67).

**Where:** `src/mcp.ts`, `cloudflare.config.ts` (env), `docs/setup.md`.

**Done when:** with `KITEBOOK_STRICT_MCP_NAME=1` a missing header gets the same `HeaderMismatch` error as a wrong one; the default is unchanged. Smoke checks for both modes.

Definition of done: `bun run typecheck` clean, `SKIP_NTFY=1 ./smoke.sh` ends in ALL PASSED, PR against `dev`.
```

### 8. `/start`: the next-step Copy button needs the same fallback as the others
**Labels:** `ui` · **Size:** XS
```markdown
**What:** most Copy buttons on `/start` use `copyText()`, which falls back to a hidden textarea when `navigator.clipboard` is missing (plain-http origins, e.g. a LAN self-host). The Copy button on a finished task's "Next:" line (`src/start.ts`, line ~357) calls `navigator.clipboard` directly and only says "Select the command and copy it by hand".

**Where:** `src/start.ts` (`copyText` around line 318, the `nextBar` Copy button around line 357).

**Done when:** that button uses `copyText()`; if both ways fail it selects the command text for the user and says "Selected: press Cmd/Ctrl+C"; "Copied" goes back to "Copy" after 2 s. The existing `/start` smoke greps still pass.

Definition of done: `bun run typecheck` clean, `npm run test:fast` passes, PR against `dev`.
```

### 9. Unit tests for the stdio bridge `mcp-stdio.mjs`
**Labels:** `tests`, `mcp` · **Size:** S
```markdown
**What:** `client/mcp-stdio.mjs` (stdio ⇄ `/mcp`, for MCP clients that only speak stdio) has no unit tests; batching, notifications, a 401 and a dropped connection aren't covered.

**Where:** `client/mcp-stdio.mjs`, a new `client/mcp-stdio.test.ts` (bun test with a local `Bun.serve` playing `/mcp`; see `client/presence.test.ts` for the style).

**Done when:** tests cover request/response passthrough, a notification (no id) forwarded with no reply written, a 401 turned into a JSON-RPC error with a fix hint, and the token read from the token file. All green under `bun test client/`.

Definition of done: `bun run typecheck` clean, `bun test client/` green, PR against `dev`.
```

### 10. Docs: a "How it works" diagram
**Labels:** `docs` · **Size:** XS-S
```markdown
**What:** newcomers ask what talks to what. The README has no picture of assistant → Kitebook ← runner → coding agent → git branch.

**Where:** a new `docs/architecture.md`, linked from the README "Learn more" table.

**Done when:** a Mermaid diagram (GitHub renders it) marks the trust boundaries: where approval happens, where code runs, that the runner dials out, and what the server never sees (agent secrets, a shell). Under 40 lines, words from `docs/glossary.md`.

Definition of done: the smoke check "every relative doc link resolves" passes (`SKIP_NTFY=1 ./smoke.sh`), PR against `dev`.
```

### 11. Runner: pass the locale and temp folder through to agents, and document `env`
**Labels:** `runner`, `agents` · **Size:** XS
```markdown
**What:** `agentEnv()` (`client/runner-agents.ts`, line ~137) gives a coding agent only `PATH`, `HOME`, `TERM` (plus Windows essentials) and the names listed in runner.json `env`. `LANG`/`LC_ALL` and `TMPDIR` aren't passed, so agents can fall back to the C locale and the system temp folder. `docs/runner.md` also doesn't say which names to add to `env` for key-based sign-in.

**Where:** `client/runner-agents.ts` (`agentEnv`), `docs/runner.md`.

**Done when:** `LANG`, `LC_ALL` and `TMPDIR` pass through when set; `docs/runner.md` lists the usual `env` names (`OPENAI_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, `CURSOR_API_KEY`, `GH_TOKEN` / `COPILOT_GITHUB_TOKEN`) and how `envFile` works. A smoke or unit check shows `LANG` reaching a fake agent.

Definition of done: `bun run typecheck` clean, `SKIP_NTFY=1 ./smoke.sh` ends in ALL PASSED, PR against `dev`.
```

### 12. Agent adapters: put `--` before the prompt where the CLI allows it
**Labels:** `agents` · **Size:** XS
```markdown
**What:** the adapters pass the prompt as the last positional argument (`build()` in `client/agent-adapters.ts`, line ~127). For CLIs that read positionals with a flag parser (opencode `run`, `cursor-agent`), a prompt that starts with `-` would be read as a flag.

**Where:** `client/agent-adapters.ts` (an `endOfFlags` field per adapter, set only where the real CLI's `--help` or docs confirm `--` works), `scripts/fake-agents.ts` (teach the fakes `--`), `client/agent-adapters.test.ts`.

**Done when:** for those adapters the argv ends in `--`, `<prompt>`; a unit test sends a prompt starting with `-` through the fake CLIs and it arrives as the prompt; other adapters are unchanged.

Definition of done: `bun run typecheck` clean, `bun test client/` green, `SKIP_NTFY=1 ./smoke.sh` ends in ALL PASSED, PR against `dev`.
```

---

Other adapter and connector ideas remain in the maintainer's launch notes. Discuss current needs and scope before proposing implementation.
