# Contributing to Kitebook

Thanks for helping. Kitebook is a small, dense TypeScript codebase: a Cloudflare Worker (the server) and a Bun runner/CLI (the client). You can run and test all of it locally, with no Cloudflare account and no Mac.

## Discuss before implementing
Kitebook has limited review capacity. Open issues track the maintainer's backlog; they are not an invitation to start work or a promise that a PR will be accepted.

1. Check existing issues and PRs for the same problem. Add reproduction steps or evidence to an existing issue rather than opening duplicates.
2. Describe the user problem, proposed approach and scope in the issue, and wait for maintainer agreement before implementation. A self-assignment or "I'll work on this" comment is not agreement. For a documentation correction, describe the correction first too.
3. After agreement, make one focused change on a branch from `dev` and open the PR against `dev`. Link the discussion where the scope was agreed.
4. Explain the behavior before and after the change, how you verified it, and any remaining limitations. Respond to review feedback before starting more PRs.

Bug reports with clear reproduction steps are welcome without prior agreement. Report vulnerabilities privately through [SECURITY.md](SECURITY.md).

## AI-assisted contributions and review
AI tools are allowed. The contributor is responsible for understanding every change, checking the generated code, and running the checks they report. State how AI tools were used in the PR. Never claim a test passed unless you ran it; report failures, skips and untested behavior plainly.

Please don't submit batches of unrelated PRs, duplicate implementations, speculative refactors or changes whose only purpose is to increase contribution counts. A small patch is welcome when it solves an agreed problem and has appropriate verification. Maintainers may close PRs without agreed scope, reproducible value or accurate verification evidence. Review and merge are not guaranteed.

## Setup (4 commands)
Needs Node 22+, [Bun](https://bun.sh) 1.4+ (CI pins 1.4.3), `jq`, `curl`, `git` and `python3`. For the headless-browser checks: `pip install playwright && python3 -m playwright install chromium` (without it those checks print `SKIP`).
```bash
git clone https://github.com/um1b/kitebook kitebook && cd kitebook
npm install && echo ADMIN_TOKEN=dev-admin-token > .dev.vars
bun run typecheck             # tsc, must be 0 errors
npm run test:fast            # unit tests + the base smoke checks, about 2 min
npm test                      # unit tests + the full smoke (~360 checks, ~15 min on a 2-CPU / 8 GB box), must end in ALL PASSED (N checks, Ms)
```
`npx cf dev` runs a local Kitebook (Workers + Durable Objects + R2 emulation) on `http://127.0.0.1:5173`, with state in `.relay-data/`. It is a development server for this machine: it answers only localhost and only as the Worker (Vite's own file serving is refused), and it is never what a self-host runs (that's `scripts/serve.sh`, plain workerd). Open `/start` and sign in with `dev-admin-token`.

## Tests
- **`bun run typecheck`**: `src/` against the generated Workers types, and `client/` + `scripts/` against Bun's types. CI fails on any error.
- **`./smoke.sh`**: the real test suite. It boots `cf dev` in a temp dir, then drives the admin CLI, the `kitebook` CLI, MCP, OAuth, a runner with fake agents, signed tasks, the KB and so on. Each check is one `pass "..."` line, and the first failure stops the run with `FAIL ...`.
  - Every run is isolated: its own temp dir (HOME, TMPDIR, Kitebook data and cache inside it), a snapshot of the checkout (so it never writes into your folder), its own block of 100 free ports below 32768, and on exit (pass, fail or Ctrl-C) it stops every process it started. So several runs can go at once, from one checkout or several; memory is the limit: a run peaks around 1.5 GB, so on a small machine (8 GB, no swap) keep it to 2 at once. `PORT=7801 ./smoke.sh` pins the port base instead (helpers use `$PORT`+51..99).
  - `./smoke.sh --sections quick-ask,signed` runs the setup and core checks plus the sections whose heading contains those words (`=key` matches a key exactly); `./smoke.sh --list` lists the sections and their keys. `SMOKE_ONLY=core` / `SMOKE_LIST=1` still work. Sections build on earlier ones, so if one fails alone, add the section before it.
  - `scripts/smoke-par.sh -j 3` splits the sections over 3 concurrent runs (each also runs the earlier sections its own lean on, uncounted) and prints one merged `ALL PASSED (N checks)` or `FAIL ...` with the same count as a serial run.
  - Sharing a machine (several people or agents testing at once)? Run each smoke through `scripts/smoke-slot.sh`, a counting semaphore made of `mkdir` locks (works where `flock` doesn't): `scripts/smoke-slot.sh -- env SKIP_NTFY=1 ./smoke.sh > smoke.log 2>&1` waits for one of the machine's slots (`-n`/`KITEBOOK_SMOKE_SLOTS`, default 2) and frees it when the run ends, however it ends; a split run holds as many slots as it has runs (`scripts/smoke-slot.sh -k 2 -- scripts/smoke-par.sh -j 2`); it takes them all at once, and after 5 min of waiting it reserves the machine (keeps each slot as it frees, other waiters hold off) so single runs can't starve it. Everyone must use the same lock prefix (`--lock`/`KITEBOOK_SMOKE_LOCK`, default `$TMPDIR/kitebook-smoke`). Slot 1 is `<prefix>.lockdir`, the directory a plain single `mkdir` lock would use, so a script that only knows that lock still counts as one smoke. A slot whose holder is gone (dead pid, a reboot) is taken over; `--status` shows who holds what.
  - The last lines count the checks and the time: `smoke: N checks in Ms; slowest sections: ...` and `ALL PASSED (N checks, Ms)`. A failure prints `FAIL ...`, and a script error prints `FAIL (script error) at line N`.
  - **The smoke has a size budget.** A full run fails once its checks pass `CHECK_BUDGET` (near the end of `smoke.sh`). The smoke was trimmed from 1,029 checks and 20+ minutes to 361 on 2026-10-23 (budget 397, the measured count +10%), so it doesn't grow back: a new feature extends or replaces an existing check (one `pass` per behaviour, several fields in one call), and doesn't add a section. Raise the budget only in the commit that removes as many checks elsewhere, or with the owner's OK.
  - Browser checks (`scripts/browser-check.py`, headless Chromium via Playwright) print `SKIP` when there is no browser; `KITEBOOK_REQUIRE_BROWSER=1` (set in CI) turns a skip into a failure.
  - `SKIP_NTFY=1` skips the one test that talks to the public ntfy.sh. CI always sets it.
  - Smoke never touches a real Kitebook, a real Mac or a real coding agent. Keep it that way.
- **`bun test client/`**: the unit tests (`*.test.ts`); `npm test` and CI run them before the smoke, so the smoke never runs them again. Pure logic (parsing, argv shapes, crypto vectors) belongs here, not in the smoke.
- **Every behaviour change is covered, inside the budget.** Extend the related section's check (one more field in its `jq`, one more case in its loop) or replace a check the change makes obsolete. What the smoke doesn't check: UI wording and layout (no `grep` on page copy), the same code path once per agent, screenshots.

## Where things live
| Path | What |
|---|---|
| `src/index.ts` | Worker front door: routing, auth |
| `src/dir.ts` | Per-account Dir Durable Object (accounts, tokens) |
| `src/mcp.ts`, `src/events.ts` | MCP handler, MCP Events |
| `src/space.ts` + `src/space/` | The Space Durable Object (one per workspace): `core → gc → events → files → tasks`, ops in `fileOps/peerOps/taskOps/kbOps` |
| `src/ops.ts` | The op table and the OpenAPI document |
| `src/start.ts`, `src/oauth.ts` | The `/start` page; OAuth (DCR, PKCE, device grant) |
| `src/guide.ts` | What agents read at `/llms.txt`. Update it when behaviour changes |
| `client/runner.ts` + `client/runner-*.ts` | The Mac runner. **Keep `client/` flat**, because the signed runner manifest and `install.sh` cover exactly `client/*.ts` |
| `client/cli.ts`, `client/admin.ts` | `kitebook` CLI (any op), admin CLI |
| `client/guard.ts` | The runner's destructive-command / deploy / spend guard |
| `client/mcp-stdio.mjs` | stdio ⇄ `/mcp` bridge for MCP clients that only do stdio |
| `docs/` | User docs (start at `docs/quickstart.md`); README "Not built yet" lists what's next |
| `smoke.sh` | The end-to-end suite |

## Branches and pull requests
- Two long-lived branches: **`dev`**, where changes land first, and **`main`**, the stable branch people install. `main` only moves by a fast-forward to a `dev` commit that CI passed and that ran on a real Mac (`scripts/promote.sh`).
- Fork, then branch from `dev`: `fix/<short-topic>` or `feat/<short-topic>`. (`hark/*` branches are made by the maintainer's own agents, and merge into `dev` too.)
- **PRs target `dev`**, not `main`. One focused change per PR. Rebase on `dev` rather than merging it in.
- For code changes, run `bun run typecheck` and `npm run test:fast`. Runner or server changes also need `SKIP_NTFY=1 ./smoke.sh` ending in `ALL PASSED`. Give the commands and actual results in the PR, including failures or skips. For documentation-only changes, validate affected links and any GitHub forms, and explain why runtime tests were not run.
- Commit messages say what changed and why, in plain words. A trailing `(smoke N)` with the new pass count is welcome.
- Update `README.md` / `docs/*` / `src/guide.ts` when user- or agent-visible behaviour changes. User-facing text follows [docs/glossary.md](docs/glossary.md) (say workspace, connected app, folders, not space, peer, `**`).
- Never commit secrets, a real `.dev.vars`, `runner.json` or keys. CI runs gitleaks.

## Code style
Dense TypeScript that matches the code around it. Comments explain *why*, not what. No new dependencies without a reason in the PR: the Worker's are listed in `package.json` (Better Auth and its plugins, kysely, zod, jose, aws4fetch, all pinned), and the runner has none beyond Bun.

## Security
Please don't open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).

## Choosing work
Discuss priorities with the maintainer first. Issues marked `priority: low` are deferred backlog work. The [launch planning notes](docs/launch/good-first-issues.md) are historical ideas, not an active task list. Check the current issue discussion and get agreement before implementing any of them.

By contributing, you agree that your contributions are licensed under the project's [MIT license](LICENSE) and that you'll follow the [Code of Conduct](CODE_OF_CONDUCT.md). No separate Contributor License Agreement (CLA) signature is required.
