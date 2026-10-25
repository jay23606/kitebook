# Quick start, step by step

The short version is in the [README](../README.md#quick-start). Words used on screen are in the [glossary](glossary.md).

## 1. Install
On your Mac, open Terminal, paste this line and press Return:
```bash
curl -fsSL https://raw.githubusercontent.com/um1b/kitebook/main/scripts/get.sh | bash
```
It asks you to choose a Kitebook master password (hidden, typed twice), with an optional fingerprint/face-unlock shortcut. An install run without a terminal stays locked and gives you a local link to set the password yourself. Downloads and the source build can take several minutes. Run it again any time: it keeps what's there and repairs what's missing. What it does:
- gets what Kitebook needs when it's missing: git (if macOS's developer tools aren't there, macOS shows its own **Install** button and the installer waits), [bun](https://bun.sh) and Node 22 (a private copy in `~/.kitebook-node`, checked against nodejs.org's checksums);
- downloads Kitebook's stable version into `~/.kitebook-app` and starts the server on your Mac: `http://127.0.0.1:7820`, started again at every login, data in `~/.kitebook-server`. It's the built server on plain workerd, never a development server;
- connects this Mac as the runner (the part that runs coding tasks), with safe defaults: ask before every task, work in a git worktree, never push;
- connects the coding agents it finds (Pi, Codex, Claude Code, Cursor, Gemini CLI, opencode, GitHub Copilot CLI, Grok CLI): each gets the installer’s configured access (review it in Settings);
- puts the `kitebook` command on your PATH (`~/.local/bin`, added for zsh and bash): open a new Terminal window and type `kitebook` for help;
- turns on automatic updates (stable version, while the Mac is idle);
- opens Kitebook in your browser, signed in. Your workspace `main` is made by itself.

Nothing is reachable from outside your Mac yet: **public access is off** until you turn it on (step 2). The log is in `~/Library/Logs/kitebook-install.log`.

## 2. Make the address reachable
`kitebook open` opens Kitebook in any browser on this Mac, signed in (a browser stays signed in for 30 days). You can also add a passkey (your phone, laptop or password manager) in **Settings → Devices & passkeys**, or press **Send a sign-in request** on `/start` and approve it on your Mac with `kitebook approve <code>`. The server's recovery code (its `ADMIN_TOKEN`) is kept in `~/.kitebook-app/.dev.vars` (mode 600); you only need it if every other way in is gone (**Use a recovery code** on `/start`). Sign-in runs on Better Auth on your Kitebook's own storage ([how it works](AUTH-ARCHITECTURE.md)).

**Public access** is what Claude.ai, ChatGPT and Hark need, since they run in the cloud. In **Settings → Connection** press **Turn on public access**: Kitebook's built-in tunnel gives your Mac a free `https://….trycloudflare.com` address (no account, no open port; cloudflared is downloaded once and sha256-checked). The address can change when the tunnel restarts; Settings → Connection always shows the current one with a Copy button, and your Mac's own runner and coding agents use the local address, so they never break. For a stable address, follow the [domain walkthrough](domain.md), including DNS, the public-listener port and the tunnel token. Quick tunnels are a trial option and do not support SSE. Some assistants may reject shared tunnel hostnames; a custom domain can be necessary for those providers. Compare [address options and compatibility](setup.md#address-compatibility-and-avoiding-a-domain) before relying on a connection for daily use. `kitebook tunnel` shows the address, `kitebook tunnel off` / `kitebook tunnel on` switch it from Terminal.

## 3. Give your daily assistant the URL

In **Settings → Connection**, use **Copy connection request** and paste it into Hark, Muse or another daily assistant. Or give it this request, with your public address:

> Connect to my Kitebook at https://kitebook.example.com. Read its /setup.md instructions, configure the connection using your supported tools and persistent secret storage, and show me the approval link. After I approve, verify access and tell me whether it will survive a sandbox restart.

The assistant reads the instructions, starts pairing and shows you a link. Open it yourself, check the requested access and approve. No recovery code or token belongs in the conversation. For a client that requires manual connector setup, add `https://<your-kitebook>/mcp` in its integrations settings instead. An app-key-only client uses **Settings → Connected apps → Add an app** and its secure credential prompt. [Detailed connection options](setup.md#connect-any-assistant-muse-others).

The assistant should verify its identity and permissions, plus its MCP tools or HTTP API, before claiming success. Persistent configuration depends on that platform's secret storage; if it cannot save credentials outside its sandbox, reconnecting may be needed after a reset. A coding task is not needed to finish setup.

On a hosted Kitebook with many accounts, your MCP URL is `https://<host>/u/<account>/mcp`. Use the account-specific link supplied by that server.

## 4. Share context and continue

Ask one assistant to save a harmless project note in Kitebook and read it back. Connect a second assistant and ask it to retrieve that note with its source. You should be able to see the note yourself in **Library**.

For real work, ask the current assistant to publish the original files and a handoff: goal, completed work, next step and open questions. The next assistant reads the handoff and recovers the linked files before continuing. After a sandbox reset, load the persistent connection and pull a fresh workspace copy. Only published work is recoverable.

[How to use Kitebook](how-to-use.md) has example requests for sharing, corrections, handoffs and restart recovery. [Workspace synchronization](workspace-sync.md) covers the protocol and backup details.

Coding help is optional. Connect a computer from **Connection options → Coding runner** when you want repository work, then ask your daily assistant to use it. Task execution follows your saved approvals; a new connection does not grant access to existing coding sessions.

## Updates
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

## Home and a task's own page
Open `/start` later, from your phone too. Home opens the shared **Library**: search knowledge, read notes, deliberately edit them, browse files and inspect handoffs. **Tasks** (`/start#tasks`) shows what you can act on now: one sentence (what needs you, what's running, whether your Mac is online), then one line per task that needs you (**Approve**), per running task (**Cancel**), and at most three recent ones (**Done** / **Failed** / **Answered**). Tap a title for **that task's own page** (`/start#task-<id>`): who sent it and to which Mac, what the agent is doing and when it last did something (marked **stuck?** after 10 minutes with no progress), **Review / Approve / Reject**, **Answer** an agent's question, **steer** a running agent, **Cancel**, the one next step (merge command or PR link), one-tap recovery for a failed, rejected, cancelled or stuck task (**Retry**, **Retry with note**, **Hand to agent**), and the summary, diff, test log and timeline. Each button works once and only from your signed-in browser (a same-origin JSON POST with a one-time nonce). **More** at the bottom holds your Mac and connected apps (Revoke in each app's ⋯ menu, behind a confirm step), the ways to connect another app, and the links for agents. When a Mac asks only on its dialog, Tasks offers to turn on phone approvals in Settings.

**Settings** is one short list: Address (Copy), Connected apps, Run tasks without asking, Install updates without asking, Signed-in devices; everything else (connection and lockdown, instructions for your assistants, approvals, passkeys and trusted browsers, updates, releases, recovery, Experimental) is under **More**. `/settings#<section>` (for example `#apps` or `#approvals`) opens the part it's in.

An agent given only the server's URL can onboard itself: `/` and `/llms.txt` name `/start`, `/mcp` + its OAuth metadata, `/openapi.json` and `/install.sh`.

## Your workspace

The desktop workspace uses the full window. Library uses a split note list and reading pane, with filters tucked away until needed. Notes open for reading; choose Edit note to make a correction, or Source & version history to inspect provenance and retained versions. Files & handoffs shows the actual shared artifacts. Tasks groups attention, progress and results separately. Use the sidebar to open connections, instructions, approvals, devices and updates directly. On a phone, navigation becomes a horizontal list, and Library switches between its list and the selected reader with an explicit Back to library action.

Use **Connection options** below the task list to add an assistant. Open **Apps & agents** to manage existing connections. Settings sections open by click or keyboard; moving the pointer over them does not change the page.

A restarted daily-agent sandbox can recover published files without GitHub. See [Restart-safe shared workspaces](workspace-sync.md) for the pull/publish workflow, conflict handling and backup/restore.
