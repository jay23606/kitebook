## Agreed scope
<!-- Link the issue discussion where the maintainer agreed to this change. An open backlog issue alone is not approval. -->

## What and why
<!-- Describe the user problem and the resulting behavior. One focused change per PR. -->

## Verification
<!-- List commands you actually ran and their results, including failures and skips. For docs-only changes, validate affected links/forms and explain why runtime tests were not run. -->
- [ ] Code changes: `bun run typecheck` and `npm run test:fast`
- [ ] Runner/server changes: `SKIP_NTFY=1 ./smoke.sh` ends in `ALL PASSED` (count: ___)
- [ ] Behavior changes have meaningful regression coverage; extend existing smoke checks within the check budget or use `bun test` for pure logic

## AI tools
<!-- State whether AI tools were used and how you checked the result. You are responsible for understanding the complete change and verifying all claims. -->

## Checklist
- [ ] Scope agreed in the linked issue; no duplicate implementation
- [ ] PR targets `dev`
- [ ] Docs updated where behavior changed (`README.md`, `docs/*`, `src/guide.ts` for what agents read)
- [ ] User-facing words follow `docs/glossary.md`
- [ ] No secrets, tokens, `.dev.vars` or `runner.json` committed
- [ ] `client/` stays flat (no subfolders; the signed runner manifest covers `client/*.ts`)
- [ ] Doesn't widen what an agent can do without the owner's approval (or the PR says so and why)

No separate CLA signature is required. See [CONTRIBUTING.md](https://github.com/um1b/kitebook/blob/main/CONTRIBUTING.md).
