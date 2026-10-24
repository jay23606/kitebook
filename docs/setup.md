# Setting up a Kitebook server

Reference for operators. The short version is in the [README](../README.md#quick-start).

## Deploy to Cloudflare
```bash
npm install
npx cf auth login                     # once
npx cf secret put ADMIN_TOKEN         # pick a long random string; it's the master key
npx cf deploy                         # prints your https://kitebook.<you>.workers.dev URL
```
R2 is optional. With the `BLOBS` bucket binding, files over 256 KB and binaries go to R2 (up to 25 MB each). Without R2, everything stays in the Durable Object (1.5 MB per file). Self-hosting stores big files on local disk instead (see [Storage](storage.md)).

## Many users on one URL (accounts)
A Kitebook server can host several people, and each one is a fully separate **account** with its own recovery code, peers, spaces and data. Nothing crosses between accounts, so two accounts can each have a peer called `hark` and a space called `main`.
```bash
KITEBOOK_ADMIN_TOKEN=<operator ADMIN_TOKEN> bun client/admin.ts signup alice   # prints alice's recovery code (ak.alice....) once, creates space main, prints the /start link
```
- **Hosted mode** (a public Kitebook strangers use): deploy with `KITEBOOK_HOSTED=1 KITEBOOK_OPEN_SIGNUP=1 cf deploy`. `OPEN_SIGNUP=1` lets anyone sign up on `/start` or `POST /signup {"account":"name"}` without the operator key (both create the `main` space); `HOSTED=1` turns on dynamic client registration (so Claude.ai/ChatGPT connect with just the URL) and per-account quotas: 3 spaces, 25 live peers, 500 MB stored per space (history included). Override kitebook-wide with `KITEBOOK_QUOTA_SPACES`/`KITEBOOK_QUOTA_PEERS`/`KITEBOOK_QUOTA_STORAGE_MB` (0 = unlimited), or for one account with `admin.ts quota alice spaces=5 storage_mb=2000` (operator key; `key=-` resets). Over a quota, the call fails with what's used, the limit and what to do. `admin.ts usage` shows an account where it stands, with its daily request and admin-command counters. Every account also keeps an append-only audit trail of what changed in it (admin commands, signup, device revokes; failed attempts too; names and ids only, never a token or key): `admin.ts audit [limit]`. `admin.ts users` lists the people in an account (today always one, its owner; the groundwork for teams). Signups are limited per IP (`KITEBOOK_SIGNUP_PER_IP_HOUR`, default 5 hosted / 20 otherwise; the operator key is exempt). The root account is never limited.
- `/start` signs the owner in to the browser (12h `HttpOnly` cookie, JSON same-origin POSTs only), so the OAuth consent page and `/device` don't ask for the recovery code again.
- Each person then uses their own recovery code as `KITEBOOK_ADMIN_TOKEN` for everything below.
- Tokens and invites carry their account (`rk.alice.…`, `inv_alice.…`), so one URL routes them straight to the right account.
- Single-user deployments keep working unchanged as the `root` account. `rotate_admin` replaces an account's key.

## Connector name
MCP clients see the connector as **Kitebook** (`serverInfo.name`). The display title defaults to "Kitebook"; set `KITEBOOK_TITLE` (and optionally `KITEBOOK_WEBSITE_URL`) in the environment when building/deploying, or give one account its own title with `bun client/admin.ts title "Sam's Kitebook"` (wins for that account's tokens; no name clears it). The stdio bridge reports the same name.

## Create a space and invite an agent
The easy way is `/start` (signed in): its cards mint these same invites with the safe presets. First sign-in on a fresh Kitebook: the one-step install opens it signed in, and `kitebook open` does it again on that Mac; a Kitebook server deployed elsewhere: paste the `ADMIN_TOKEN` under **Use a recovery code**. Workspace `main` is created by itself the first time you sign in or make an invite for it (`bun client/admin.ts space <id>` makes others). From the CLI:
```bash
export KITEBOOK_URL=https://kitebook.<you>.workers.dev KITEBOOK_ADMIN_TOKEN=<admin token>
bun client/admin.ts invite main assistant read,write,dispatch '**' 'write:shared/**' 'write:kb/**'      # assistant preset -> https://.../join/inv_xxx
bun client/admin.ts invite main runner read,write,delete,dispatch 'tasks/**' 'shared/**' 'repos/**' 'kb/**'   # runner preset, for your Mac
```
**Give the invite URL to the agent. That's the whole setup.** The agent opens it, reads the instructions there, claims its own token (once, within 24h), and connects. Use the narrowest verbs and paths that work: `read`, `write`, `delete`, `dispatch`, and globs like `docs/**`. The two lines above are the safe presets (the same grants `/start` and OAuth `preset:assistant` / `preset:runner` give): an assistant reads everything and dispatches but writes only `shared/**` and `kb/**` (code goes in through git or `change`); avoid a bare `'**'` with `write`, which lets a peer rewrite anything in the space.

Other admin commands: `peer` (mint a token directly), `grant`, `revoke`, `rotate`, `list`, `grants` (OAuth approvals), `revoke_grant <id>` (end one approval), `usage`, `export`, `import`.

A path glob can narrow one verb: `write:shared/**` means that verb only there, while plain globs cover the others. So paths `** write:shared/**` read everything but write only `shared/**`.

## Sign in with OAuth instead of an invite
Invites keep working. OAuth 2.1 is the other way in, and it's what Claude.ai / ChatGPT connectors and the Pi / Codex / Claude Code CLIs expect. Either way the result is a connection (a peer) with a grant on one space. Sign-in and OAuth run on [Better Auth](AUTH-ARCHITECTURE.md), one instance per account, stored in that account's own Durable Object (SQLite), so it works the same on Cloudflare and on plain workerd.
- **MCP connectors and CLIs:** add `https://<host>/mcp` (`claude mcp add --transport http kitebook https://<host>/mcp -s user`, `codex mcp add kitebook --url https://<host>/mcp && codex mcp login kitebook`, `pi mcp add kitebook --url https://<host>/mcp && pi mcp login kitebook` (Pi 0.99 or newer: `npm i -g @earendil-works/pi-coding-agent`; an older Pi has no `pi mcp` and would take those words as a prompt), or a custom connector in Claude.ai / ChatGPT). The client finds `/.well-known/oauth-protected-resource/mcp` from the 401, then the authorization server (`/.well-known/oauth-authorization-server/api/auth`), identifies itself with a Client ID Metadata Document (its https client id) or registers itself, and sends you to the consent page. Not signed in: your Kitebook's sign-in page first (`kitebook open`, passkey, or a sign-in request), then straight back. A self-registered app is marked **unverified name**; a CIMD app shows the host its details come from.
- **Asked every time:** an app is asked about on every connect, unless it still has a grant you can see (and remove) in Settings → Connected apps; then it signs in again with no page. Removing it (or its end date passing) stops its tokens at once, and the next connect asks again. One app installed on two computers (one CIMD client id) shares one connection.
- **Hosted Kitebook servers (many accounts on one URL):** each account is its own issuer: its MCP URL is `https://<host>/u/<account>/mcp` (authorization server `https://<host>/u/<account>/api/auth`, sign-in page `/u/<account>/start`). A self-hosted Kitebook (the root account) keeps `https://<host>/mcp`. One account's keys, clients, sessions and tokens never work for another.
- **Who may register (`OAUTH_DCR`, build env `KITEBOOK_OAUTH_DCR`):** registering a client grants nothing; only your approval on the consent page does. By default (unset) anyone may register a **public** client (`token_endpoint_auth_method: none`; PKCE S256 is required anyway) whose `redirect_uris` are all loopback http (`127.0.0.1`, `[::1]`, `localhost`, any port) or https. Claude.ai and ChatGPT, which register with a client secret, are allowed by default too, but only when every redirect is on their own https hosts (`claude.ai`, `claude.com`, `chatgpt.com`, `chat.openai.com`), so a code can only go back to them. Any other confidential client (with a secret) or an app-scheme redirect needs `OAUTH_DCR=1` (every valid registration; also the default with `HOSTED=1`); `OAUTH_DCR=0` turns self sign-up off. Apps with a Client ID Metadata Document need no registration in any mode.
- **Limits:** registration is rate limited per IP (`OAUTH_DCR_PER_IP_HOUR`, 20); new grants per account (`OAUTH_GRANTS_PER_HOUR`, 30). A self-registered client you never approved is deleted after a day (`OAUTH_CLIENT_UNUSED_TTL`), even if its consent page was opened.
- **Consent choices:** *Read everything, save to shared memory, send tasks* (the default and recommended, the same as the assistant preset: `read dispatch` on `**`, `write` only on `shared/**` and `kb/**` so `kb_add` to `kb/global` or a project works; you approve each task on your Mac; the `/connect` pairing page and Add an app default to it too), *Just this folder* (`read write` on `kb/<app>/**`, no tasks), *Read only* (`read` on `**`); under More options *run tasks on its own* in the projects you pick (a signed standing permission), *Everything* (`read write delete` on `**`), or *Choose exactly* (verbs and paths by hand).
- **Tokens:** access tokens are JWTs (1 hour, signed by the account's own key, audience = its `/mcp`) and work on `/mcp`, `/v1` and `/v1/stream` exactly like that connection's token, narrowed to the approved space and verbs; every call checks the grant live. Refresh tokens rotate on every use and last 30 days from their last use (sliding, `OAUTH_REFRESH_TTL`). Codes are single use (a replayed code also ends the tokens it led to). `POST /api/auth/oauth2/revoke` (RFC 7009).
- **Device sign-in (Hark, runners, any CLI):** `bun client/cli.ts login --device https://<host> --name hark --space main --scope "read write dispatch"` (add `--role runner` for a runner). It prints a code and a `/device` link; open it signed in, check the code and permissions, Approve. Tokens are saved to `~/.config/kitebook/credentials.json` (0600, `KITEBOOK_CREDENTIALS` to move it); with no `KITEBOOK_TOKEN` set the CLI uses and refreshes them. `kitebook token` prints a current access token for scripts, `kitebook logout` revokes the grant. (The device grant still issues the original `at.`/`rt.` token format; it moves to Better Auth later.)
- **Presets:** scope `preset:assistant`, `preset:coding_agent` or `preset:runner` picks a safe grant for the device grant; explicit verbs or `path:` words override it.
- **After updating from a Kitebook server before Better Auth:** apps' existing tokens keep working (refresh included) until they sign in again; an app with an old client id is told in plain words to remove its Kitebook connection and add it again (it signs itself up again; its access stays in Settings until you remove it). Browsers sign in again once. Passkeys can't be carried over: Settings asks once to add yours again.
- Lifetimes are env knobs (`OAUTH_ACCESS_TTL`, `OAUTH_REFRESH_TTL`, `OAUTH_GRANT_MAX_TTL`, `OAUTH_DEVICE_TTL`, `OAUTH_INTERVAL`, `OAUTH_SLOWDOWN`, seconds) in `cloudflare.config.ts`.
- **Self-revoke:** any peer can end its own credential with the `revoke_self` op (a peer token revokes the peer, an OAuth token just its grant).

## Connect any assistant (Muse, others)
An assistant that only knows your Kitebook's address can connect itself; you approve it once. Paste this into the assistant (put your host in, and change `muse` to the app's kind):

> Connect to my Kitebook at https://<host>: POST https://<host>/connect with {"agent":"muse","name":"<your own name>"}, show me the link it returns, then poll https://<host>/token with grant_type=urn:ietf:params:oauth:grant-type:device_code and the device_code until you get the access token. Use it as Authorization: Bearer for https://<host>/mcp (Streamable HTTP), test whoami and tools/list, then save it as a skill.

- **The link** (`/device?user_code=...`) says "Connect muse-<name> to your Mac". Type your master password and press Enter (or use the fingerprint / face unlock button) and it's connected with read + send tasks (you approve each task it sends). The connection is called `<agent>-<name>` (lowercase; a second one with the same name gets `-2`). No client id is needed anywhere. If the page can't reach your Mac's helper, run `kitebook approve <code>` on the Mac instead.
- **Claude.ai / ChatGPT and other OAuth apps:** add `https://<host>/mcp` as a connector as usual. An app that can't register can go straight to `https://<host>/authorize?agent=claude&name=<name>&redirect_uri=...` with PKCE (S256) and no client_id; you approve on the consent page, which shows where approving sends you. The same name from another redirect address becomes a separate `<agent>-<name>-2`.
- **Apps that only take an API key:** Settings -> Connected apps -> Add an app (or `kitebook app add Muse --access tasks --days 7` on the Mac). Pick what it may do and for how long; you get a key once and a prompt to paste into the app, which asks you for the key through its own secure credential prompt. Remove the app to end the key.
- Discovery lives at the root too (`/.well-known/oauth-authorization-server`, with `/connect` as the device endpoint); `/authorize`, `/token` and `/register` are short aliases; `/llms.txt` explains the steps; and a 401 from `/mcp` says how to connect.

## Upgrading an older Mac host

**Simplest: `git pull` in the Kitebook checkout.** If your Mac's runner runs from a git clone (`~/code/relay`), a plain `git pull` is the update. You or your coding agent (Pi, Codex...) can run it.

- **First pull on a very old runner** (afa48a4, 183fa70, from before the runner watched its checkout): restart the runner once after the pull with `kitebook restart runner`. With no `kitebook` command on PATH: `cd ~/code/relay && bun client/runner.ts service ~/relay-cf/runner.json restart runner` (use your runner.json path).
- **What the runner checks:** the tree is clean and the pull is a fast-forward to a commit on origin's main or dev (fetched by the runner itself). It then runs the new code's selfcheck and restarts into it once idle; Settings -> Updates history says "updated to <sha>". On a server still on `cf dev` it also runs the host upgrade below by itself (leak closed, admin and runner tokens replaced).
- **What it refuses:** a local commit, a commit from another remote or branch, a downgrade or a dirty tree is never restarted into. A commit that fails its selfcheck is rolled back (`git reset --keep`). To turn the watcher off, set `"gitWatch": false` in runner.json.
- **The `kitebook` command:** the runner puts it in place when it is missing or broken (`~/.local/bin/kitebook`, running this checkout's `client/cli.ts`, plus the old `relay` name on a Mac set up before the rename). If a new login shell wouldn't find it, the runner adds one marked block (`# >>> kitebook ...`) to `~/.zprofile` and `~/.zshrc` (zsh) or `~/.bashrc` and `~/.profile` (bash), says so in its log, and the command works in the next Terminal window you open.
- **Every install and update path checks this** (scripts/get.sh, install.sh, get.ps1 via the user PATH, a git pull, the host upgrade, the signed self-update): a fresh login shell must find `kitebook`. If it doesn't, the PATH block is repaired once and checked again; if it still isn't found you get one line with the exact fix, also shown in Settings -> Updates and in `kitebook doctor` ("kitebook command on PATH"). By hand: `bun client/cli-path.ts install`.

**Hosts still on `cf dev` need the host upgrade.** A Mac that has hosted Kitebook since before the production server (its launchd job `dev.kitebook.server` still runs `cf dev`) should be upgraded now. `cf dev` is Vite, a development server, and it also hands out the project folder itself (sources, `?raw`, `/@fs/<any path>`), so anyone with the public address can read `runner.json` (the runner's token), `.dev.vars` (the admin token) and the data folder.

**It's part of the normal update; there's nothing to paste.** Update the way you always do:

- **Settings -> Updates -> Update to dev now** (needs Experimental on, in Settings -> More; an older host's page calls this button **Update to main now**), or
- `kitebook update` in Terminal (a git-clone runner whose config sits in the server folder: `kitebook update --config ~/relay-cf/runner.json`, then `y`).

This works from the runner you have now, even an old one (afa48a4). The update moves the clone and restarts the runner on the new code. The new runner sees that you approved exactly this commit (the pinned commit of your click, or your Terminal update in the audit log) and that the server is still `cf dev`, and runs the upgrade below by itself before it connects.

- One try per update you approve: `kitebook status` says if the server still needs it, and `kitebook update` tries again.
- Every later update does the same through the new code's own step (`client/host-upgrade.ts post-update`, run from the clone right after the fast-forward).
- Agents can't start it: a task's process is refused, and a runner restart or an agent's update carries no approval of yours.

By hand (same script, same result), from the git clone (it asks nothing):
```bash
cd ~/code/relay && git pull --ff-only && bash scripts/upgrade-mac-host.sh
```
`scripts/upgrade-mac-host.sh` upgrades the server folder in place (default `~/relay-cf`; `KITEBOOK_SERVER_DIR` if yours is elsewhere) and leaves your tunnel alone:
1. Looks first: the old job and its port, the port your own cloudflared tunnel sends traffic to (from its config, so the new server answers on the same port and the public address doesn't change), `.dev.vars`, and the cf dev data (`.relay-data`, `.cloudflare/state` or the job's `KITEBOOK_DATA`).
2. Prepares an in-place update without creating backup folders.
3. Stops the old server (this alone closes the leak), copies the code from the clone (never `.git`, `node_modules`, `.dev.vars`, the data, `runner.json`), runs `npm install` and builds.
4. Copies the data into `~/.kitebook-server` with `scripts/migrate-cfdev.ts` (the old folder is never changed), replaces the admin token (it was readable too; sign in again with `kitebook open`), and runs `scripts/serve.sh` (workerd) under the same launchd job.
5. Checks `/health` locally and on the public address for up to 3 minutes, and that `runner.json`, `.dev.vars`, the sources and `package.json` are no longer served. If anything fails after the server was stopped, it leaves it stopped (Kitebook is offline until a retry finishes) and says how to retry: `kitebook update`. The old cf dev server is never started again, not even at the next login, because it leaked your tokens. A data folder that already holds data from an earlier try is checked before anything is stopped. The original cf dev data stays in place, and a completed migration stays in the new data folder; an existing database is never moved aside or overwritten.
6. Replaces the runner's token on the server and in `runner.json` (mode 600, never shown), restarts the runner and waits until it's back online.
7. Looks through the old logs for requests to `/@fs`, `runner.json`, `?raw` or the data folder from outside this Mac and prints how many, with the first addresses and times. The old server didn't record every request, so the tokens are replaced either way.

It ends with a short summary (version, port, where the data is, the tokens replaced, runner online, exposure, no backup folders) and logs every step to `~/Library/Logs/kitebook-upgrade.log` without any token in it. Running it again is safe: an upgraded Kitebook just gets the new code and the same checks (`KITEBOOK_ROTATE=1` replaces the runner token again), and a run that stopped halfway can be retried. An incomplete migration that left a populated destination needs resolving first; the script refuses to overwrite it. `bash scripts/upgrade-mac-host.sh --dry-run` only looks: what it found, what it would do, and whether the server leaks right now.

## Linux and Windows
Kitebook's server, runner and `kitebook` command run on macOS, Linux and Windows. The differences are in [client/platform.ts](../client/platform.ts)
(one place) and the service tooling; nothing here asks you to type `launchctl`, `systemctl` or `schtasks`: `kitebook status`, `kitebook restart`,
`kitebook logs`, `kitebook stop`, `kitebook start` work the same everywhere.

**Linux.** The one-step install is the same line as on a Mac (`curl -fsSL https://raw.githubusercontent.com/um1b/kitebook/main/scripts/get.sh | bash`);
it needs git from your package manager and gets bun and a private Node 22 itself, puts the server under the service tooling below, logs to
`~/.local/state/kitebook/kitebook-install.log`, and opens the browser only when there is a desktop (else `kitebook open`). By hand: `bun client/runner.ts install ~/.kitebook/runner.json` writes a systemd user unit (`~/.config/systemd/user/kitebook-runner.service`,
`Restart=always`, your PATH plus `~/.local/bin`, `~/.bun/bin`, npm's bin) and starts it; `kitebook logs runner` reads the journal. A user service
runs while you're signed in; on a server or an SSH box run `loginctl enable-linger $USER` once (the installer says so when it's off). No
systemd (WSL without it, a container): Kitebook's supervisor (`client/supervise.ts`) runs it instead, restarts it 10 s after it stops, logs to
`~/.local/state/kitebook/`, and an XDG autostart entry starts it at desktop login. The server: `bun client/jobs.ts install kitebook-server --cwd <checkout>
--env PORT=7820 -- bun scripts/serve.ts` (the same tooling; `scripts/serve.ts` is `scripts/serve.sh` without bash). Approvals: a zenity
dialog, or a notify-send notification with Approve / Reject buttons, when there is a desktop; otherwise the review page on `/start` (Status)
or `kitebook approve`. The release key goes in your login keyring (`secret-tool`), else a 0600 file.

**Windows 10/11.** In PowerShell: `irm https://raw.githubusercontent.com/um1b/kitebook/main/scripts/get.ps1 | iex`. It needs no admin: git
(winget for your user, else a private MinGit checked against GitHub's digest), bun, a private Node 22 (checked against nodejs.org's sums),
the code in `~\.kitebook-app`, the server on `127.0.0.1:7820` (data in `~\.kitebook-server`), this PC as its runner, `kitebook.cmd` in
`%LOCALAPPDATA%\Kitebook\bin` (added to your user PATH), and the browser opened signed in. Both jobs run under Kitebook's supervisor, which a
per-user Scheduled Task starts hidden when you sign in (if Windows refuses the task, a launcher in your Startup folder does the same); logs are in
`%LOCALAPPDATA%\Kitebook\logs`. Agent CLIs installed by npm (`codex.cmd`, `claude.cmd`, `gemini.cmd`...) are started as `node <script>`, so a
prompt is never re-read by cmd.exe; other `.cmd`/`.bat` files go through cmd.exe with every argument escaped. Verify commands run in Git's
`sh` (Git for Windows ships it), else cmd.exe. Approvals: a message box (Yes = Approve, No = Reject) plus the review page. The release key goes
in Credential Manager. `kitebook open` and `kitebook approve` work at the computer: with no `/proc` or `lsof` on Windows, the command listens on
a loopback port while it waits and names it in its request, and the runner asks Windows who owns that socket (`netstat -ano`) and walks the
CIM process table (a process the runner started is refused; `kitebook approve` must come from a program started from your desktop, i.e.
PowerShell or Windows Terminal). Public access: the installer sets up the built-in tunnel's helper as a third job under the same supervisor,
idle; **Settings → Connection → Turn on public access** (or `kitebook tunnel on`) downloads `cloudflared-windows-amd64.exe` once into
`~\.kitebook\bin`, checks its sha256 against the pinned release, and starts it (Windows on Arm runs the x64 build). An install from before
this gets the helper the first time you run `kitebook tunnel on` (or `kitebook tunnel install`). The same helper is set up on Linux by `get.sh`.

**No dialog, no terminal, no phone.** With `approve` unset and nothing that can ask on the machine (a service with no desktop, a headless
box), tasks wait on the review page (`/start` → Status) and for `kitebook approve`; `kitebook doctor` and the runner's start-up print a
warning with `kitebook set <runner.json> approve browser` to make that explicit. A way you chose that can't work here (`approve phone` with
no ntfy topic, `approve terminal` under a service) is still a FIX.

**What is tested where.** Every OS in CI (`platforms` job): the unit tests, including `client/platform.test.ts` (each OS's choices with the
platform passed in) and `client/supervise.test.ts` (the supervisor for real), and `scripts/selftest.ts` (the real server on workerd, a runner
with a fake agent, a task on its own branch, verify through this OS's shell, the service manager it picks). Windows also runs `get.ps1` from
the checkout. `smoke.sh` (Linux) covers `get.sh` end to end on Linux (no systemd, no desktop), the systemd unit (a fake systemctl), the supervisor with the real runner, and the Windows logon task
with a fake schtasks.

## Your master password (and the optional fingerprint / face unlock shortcut)

Everything that grants or widens access (approving a computer, an app or a sign-in, more access for an agent, Run tasks without asking or Experimental on) asks you to confirm it's you on one of your computers. The baseline way is your **Kitebook master password**, on every OS, including Linux servers and containers. Fingerprint or face unlock is an optional shortcut next to it, never the only way: if the shortcut or its helper breaks, Kitebook asks for the password instead.

- **Set it at install.** At a terminal, `get.sh`, `get.ps1`, `install.sh` and `kitebook login <url>` ask for it (hidden, typed twice, at least 8 characters, with a strength hint). Later, or again: `kitebook password set`. It is Kitebook's own password, not your computer's login. It never leaves the computer: it Argon2id-encrypts a key there (`~/.kitebook/keys/<name>.password.json`), and the server only stores that key's public half and checks signatures.
- **Installed by an agent or a script (no terminal)?** Then nothing is asked and the computer finishes **locked**: nothing can be approved from it. The install prints a one-time local setup link, `http://127.0.0.1:<port>/setup-password#t=<token>` (works once, for 15 minutes; the token is only in the `#` part). The agent hands that link to you and stops there; you open it on that computer and type the password yourself. Settings -> Devices and Get started show the link too while it is valid, and say when and how the password was set. Expired: `kitebook password link` makes a new one, or `kitebook password set` in a terminal.
- **Agents never choose it.** An agent must never open the setup link, type or store your master password, or run `kitebook password set|change|link` for you. Residual risk, plainly: a program running as you on that computer could open the link before you do; if Settings says the password was set at a time you didn't, reset it.
- **Fingerprint / face unlock:** `kitebook password shortcut on` (asks for the master password once), `off` any time (also Settings -> Devices -> turn the shortcut off). A Mac from before the master password keeps its fingerprint shortcut; the dashboard shows "Set a master password" until you run `kitebook password set` there.
- **Change it:** `kitebook password change` (the old password, or the shortcut, confirms first).
- **Forgot it:** on the server's shell `kitebook owner reset-password [<device id>]` (when that computer is the server itself, it opens a new setup link right away), or from another of your computers Settings -> Devices -> Reset password (or `kitebook devices reset-password <id>`). That computer may then set a new one within 15 minutes: `kitebook password set`. Wrong passwords are counted on the computer: three are free, then each try waits longer (30 s, 1 min, 2 min ... up to 15 min).
- **Cloud machines:** a cloud machine that only runs agents needs no URL and no password. Run `kitebook join <url-of-your-kitebook>` on it (outbound only) and approve its code from one of your computers (password or fingerprint). Only the machine hosting the Kitebook server needs a URL for cloud assistants (Claude.ai, ChatGPT). A joined machine without a password runs tasks but can't approve anything, and it can't give itself a password (an agent on it could otherwise make it an approver): to approve from it later, press Allow a password next to it under Settings -> Devices on another computer (or `kitebook devices reset-password <id>`), then run `kitebook password set` on it within 15 minutes.



## Address compatibility and avoiding a domain

Local coding agents should use the local listener. For remote assistants, address reachability and the assistant's hostname policy are separate checks. [Tailscale Funnel publishes an HTTPS ts.net address to the internet; Serve limits access to the tailnet](https://tailscale.com/kb/1223/funnel). A Tailscale API plugin alone does not prove that the assistant sandbox can reach your private service or that ts.net is allowed as an MCP destination.

| Connection | Evidence and next step |
| --- | --- |
| Hark with ts.net | The Kitebook owner reports rejection and uses a custom domain. This is an observed account/setup restriction, not a verified universal vendor policy. |
| Muse with a Tailscale plugin | Plugin support is reported; acceptance of ts.net for Kitebook MCP/API remains unverified. Test identity and tools/list from that actual sandbox. |
| Other remote assistants | Test DNS/TLS/reachability, then authentication and tools/list. Classify provider hostname rejection separately from a Kitebook failure. |

Prefer a supported no-domain path when verified. A custom domain is a compatibility fallback for restrictive hosts, not a requirement for every agent. Quick-tunnel URLs can change on restart, so a successful connection does not establish a stable address. Do not expose a service or join an assistant to your tailnet automatically. Settings → Connection shows the compatibility evidence and its limits. `kitebook mcp diagnose` separates DNS/TLS/network failures from expired credentials or denied permissions, from the client where it runs; it cannot detect another provider's hostname allowlist. Provider-specific live verification remains tracked in #19.

See [discovery and restart lifecycle](agent-discovery.md) for models, native conversation status and MCP refresh.
