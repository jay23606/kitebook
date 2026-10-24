# Security policy

Kitebook sits between cloud assistants and a machine that runs code. Security reports are the most valuable contribution you can make, and we take every one seriously.

## Reporting a vulnerability
**Please don't open a public issue.** Report privately through GitHub: **Security → Report a vulnerability** on this repo ([new advisory](https://github.com/um1b/kitebook/security/advisories/new)).

Please include what you found, how to reproduce it (a smoke-style script is ideal), and the commit you tested. Never include real tokens or invite links; reproduce against a local `npx cf dev`.

What to expect: an acknowledgement within 3 days, an assessment within 7, and a fix or a plan within 30 for anything confirmed. We'll credit you in the advisory and changelog unless you'd rather we didn't.

## What's in scope
Anything that breaks the model in [docs/security.md](docs/security.md), especially:
- a task running on a runner **without the owner's approval** (or with an approval bound to a different payload), or a signed-dispatch / signed-chain / signed-KB check that can be bypassed;
- a connected app reading or writing outside its folders, or one account reaching another account's workspace in hosted mode;
- the server learning an agent secret, or the secret guard / redactor letting a credential through into the workspace or KB;
- getting around the runner's guard (destructive commands, deploy / spend / send gate, protected files, kill switch) or tampering with its hash-chained audit log;
- install / update integrity: the runner manifest, its Ed25519 release signature, `install.sh`, `kitebook-svc update`;
- the Mac self-host (`scripts/mac-host.sh` -> `scripts/serve.sh`, plain workerd): anything other than the Worker reachable through the tunnel (project files, the data folder). `npx cf dev` is a development server for this machine only: it answers loopback hosts and the Worker only, and running it behind a public tunnel is unsupported;
- OAuth / device-grant / `/start` session issues (CSRF, redirect handling, token leakage), and SSRF via webhooks or MCP Events callbacks.

Out of scope: an owner deliberately turning protections off (`approve: auto` + `access: full` is a documented opt-in), denial of service against a Kitebook server you host yourself, and bugs in Cloudflare, Bun or the coding agents themselves.

## Supported versions
Only `main` is supported until there are tagged releases.
