## What and why
<!-- One or two sentences. Link the issue: Fixes #123 -->

## How it was tested
- [ ] `bun run typecheck` is clean
- [ ] `SKIP_NTFY=1 ./smoke.sh` ends in `ALL PASSED (N checks)` (N: ___)
- [ ] New or changed behaviour has a smoke `pass "..."` check (or a `bun test` unit test)

## Checklist
- [ ] Docs updated where behaviour changed (`README.md`, `docs/*`, `src/guide.ts` for what agents read)
- [ ] User-facing words follow `docs/glossary.md`
- [ ] No secrets, tokens, `.dev.vars` or `runner.json` committed
- [ ] `client/` stays flat (no subfolders; the signed runner manifest covers `client/*.ts`)
- [ ] Doesn't widen what an agent can do without the owner's approval (or the PR says so and why)
