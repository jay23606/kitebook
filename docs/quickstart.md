# Quick start, step by step

The short version is in the [README](../README.md#quick-start). Words used on screen are in the [glossary](glossary.md).

## 1. Install
On your Mac, open Terminal, paste this line and press Return:
```bash
curl -fsSL https://raw.githubusercontent.com/um1b/kitebook/main/scripts/get.sh | bash
```
It asks nothing and takes a few minutes. Run it again any time: it keeps what's there and repairs what's missing. What it does:
- gets what Kitebook needs when it's missing: git (if macOS's developer tools aren't there, macOS shows its own **Install** button and the installer waits), [bun](https://bun.sh) and Node 22 (a private copy in `~/.kitebook-node`, checked against nodejs.org's checksums);
- downloads Kitebook's stable version into `~/.kitebook-app` and starts the server on your Mac: `http://127.0.0.1:7820`, started again at every login, data in `~/.kitebook-server`. It's the built server on plain workerd, never a development server;
- connects this Mac as the runner (the part that runs coding tasks), with safe defaults: ask before every task, work in a git worktree, never push;
- connects the coding agents it finds (Pi, Codex, Claude Code, Cursor, Gemini CLI, opencode, GitHub Copilot CLI, Grok CLI): each gets its own notes folder and can't send tasks (change it in Settings);
- puts the `kitebook` command on your PATH (`~/.local/bin`, added for zsh and bash): open a new Terminal window and type `kitebook` for help;
- turns on automatic updates (stable version, while the Mac is idle);
- opens Kitebook in your browser, signed in. Your workspace `main` is made by itself.

Nothing is reachable from outside your Mac yet: **public access is off** until you turn it on (step 2). The log is in `~/Library/Logs/kitebook-install.log`.

## 2. Sign in later, and public access
`kitebook open` opens Kitebook in any browser on this Mac, signed in (a browser stays signed in for 30 days). You can also add a passkey (your phone, laptop or password manager) in **Settings → Devices & passkeys**, or press **Send a sign-in request** on `/start` and approve it on your Mac with `kitebook approve <code>`. The server's recovery code (its `ADMIN_TOKEN`) is kept in `~/.kitebook-app/.dev.vars` (mode 600); you only need it if every other way in is gone (**Use a recovery code** on `/start`). Sign-in runs on Better Auth on your Kitebook's own storage ([how it works](AUTH-ARCHITECTURE.md)).

**Public access** is what Claude.ai, ChatGPT and Hark need, since they run in the cloud. In **Settings → Connection** press **Turn on public access**: Kitebook's built-in tunnel gives your Mac a free `https://….trycloudflare.com` address (no account, no open port; cloudflared is downloaded once and sha256-checked). The address can change when the tunnel restarts; Settings → Connection always shows the current one with a Copy button, and your Mac's own runner and coding agents use the local address, so they never break. For an address that never changes, paste a Cloudflare tunnel token there. `kitebook tunnel` shows the address, `kitebook tunnel off` / `kitebook tunnel on` switch it from Terminal.

## 3. Updates
Kitebook updates itself: while your Mac is idle it moves to the newest stable version (the `main` branch, which only moves after CI and a real Mac run), and if the new version doesn't start or the server fails its health check it goes back to the version before by itself. Settings → More → Updates shows the version and what happened; **Update now** shows at the top of Settings while an update is ready, next to the **Install updates without asking** switch (turn it off to update only when you press the button). Experimental (Settings → More) adds **Update to dev now**, the channel where tested builds land first. From Terminal: `kitebook update`.

<details><summary>Advanced: other ways to run Kitebook</summary>

You need Node 22+, [bun](https://bun.sh) and a clone (`git clone https://github.com/um1b/kitebook kitebook && cd kitebook`).

**An always-on Mac, chosen by hand.** `./scripts/mac-host.sh` asks how assistants reach the Mac (the built-in tunnel, Tailscale Funnel or ngrok) and opens `/start` signed in. Then press **Connect your Mac** on `/start` and run its line (`curl -fsSL http://127.0.0.1:7820/install.sh | sh -s -- <invite>`). Details and plain workerd: [storage](storage.md).

**Cloudflare Workers.**
```bash
npm install
npx cf auth login                     # once
npx cf secret put ADMIN_TOKEN         # pick a long random string; it's your master key and recovery code
npx cf deploy                         # prints your https://kitebook.<you>.workers.dev URL
```
Sign in on `/start` with the `ADMIN_TOKEN` (**Use a recovery code**), then connect your Mac with the **Connect your Mac** line. For a public Kitebook strangers sign up on: `KITEBOOK_HOSTED=1 KITEBOOK_OPEN_SIGNUP=1 npx cf deploy` (accounts, quotas and limits in [setup](setup.md)). If Claude.ai or ChatGPT can't finish connecting to your Kitebook (their registration is refused), see [who may register](setup.md#sign-in-with-oauth-instead-of-an-invite).

**Locally, just to try it.** `./scripts/quickstart.sh` starts a development Kitebook on `http://127.0.0.1:5173`, connects this computer and signs your browser in (`./scripts/quickstart.sh stop` stops it). Cloud assistants can't reach `127.0.0.1`.

**The Connect your Mac line** (any kitebook): `curl -fsSL https://<your-kitebook>/install.sh | sh -s -- <invite>` installs the runner from the server (every file checked against its sha256 manifest and release signature, [runner integrity](runner.md#runner-integrity)), writes `~/.kitebook/runner.json` (mode 600), starts it at login on macOS (on Linux: `kitebook run`, or a systemd user unit named `kitebook-runner`, [runner](runner.md)), asks once whether to connect the coding agents it found, and puts the `kitebook` command on your PATH. `KITEBOOK_VERBOSE=1` shows every step.
</details>

## 4. Connect an assistant
- **Claude.ai / ChatGPT:** add a custom connector with `https://<your-kitebook>/mcp`. Your Kitebook's consent page opens: approve it with the recommended **Read everything, save to shared memory, send tasks** (it can save to `shared/` and `kb/`, so `kb_add` works). You approve each task it sends unless you later let it run on its own in a project. No token to copy. Claude.ai and ChatGPT register themselves on a default kitebook; they need its public address (a Cloudflare deploy or the Mac host's tunnel), not `127.0.0.1`.
- **Hark:** copy its invite link from `/start` and give it to Hark.
- **Claude Code, Codex, Pi** (installed after Kitebook): run `kitebook agents` on the Mac, or press Connect in **Settings → Coding agents**.

What each choice on the consent page means, and how to change it later in **Settings → Connected apps**: [features](features.md#safe-by-default). On a hosted Kitebook with many accounts, your MCP URL is `https://<host>/u/<account>/mcp` ([setup](setup.md)).

## 5. Send a task
Ask the assistant something like: *"Use Kitebook to send my Mac a small coding task: in one of my projects, add a short How to run it section to the README. Tell me when it is done and what changed."*

Your Mac asks you to approve it (a Mac dialog, `kitebook approve` in Terminal, **Approve** on `/start`, or your phone if you turned that on in **Settings → Approvals**). Once approved, the coding agent works in a git worktree and the result comes back: done or failed, what changed, tests, the branch, and the one next step (a merge command or a PR link).

## Home and a task's own page
Open `/start` later, from your phone too. **Home** shows only what you can act on now: one sentence (what needs you, what's running, whether your Mac is online), then one line per task that needs you (**Approve**), per running task (**Cancel**), and at most three recent ones (**Done** / **Failed** / **Answered**). Tap a title for **that task's own page** (`/start#task-<id>`): who sent it and to which Mac, what the agent is doing and when it last did something (marked **stuck?** after 10 minutes with no progress), **Review / Approve / Reject**, **Answer** an agent's question, **steer** a running agent, **Cancel**, the one next step (merge command or PR link), one-tap recovery for a failed, rejected, cancelled or stuck task (**Retry**, **Retry with note**, **Hand to agent**), and the summary, diff, test log and timeline. Each button works once and only from your signed-in browser (a same-origin JSON POST with a one-time nonce). **More** at the bottom holds your Mac and connected apps (Revoke in each app's ⋯ menu, behind a confirm step), the ways to connect another app, and the links for agents. When a Mac asks only on its dialog, Home offers to turn on phone approvals in Settings.

**Settings** is one short list: Address (Copy), Connected apps, Run tasks without asking, Install updates without asking, Signed-in devices; everything else (connection and lockdown, instructions for your assistants, approvals, passkeys and trusted browsers, updates, releases, recovery, Experimental) is under **More**. `/settings#<section>` (for example `#apps` or `#approvals`) opens the part it's in.

An agent given only the server's URL can onboard itself: `/` and `/llms.txt` name `/start`, `/mcp` + its OAuth metadata, `/openapi.json` and `/install.sh`.
