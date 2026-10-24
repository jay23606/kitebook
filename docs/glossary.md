# Glossary: the words Kitebook shows people

One name per concept on every screen and message a person reads (/start, the connect and approval pages, install.sh, the
runner's `init`/`doctor` output, CLI errors, error hints). The internal name stays in code, API ops, JSON fields, CLI flags
and config keys; this table is how the two line up. `scripts/plain-words.py` (run by smoke on /start) flags the internal
words when they show up bare.

| Say this | Not this (internal) | Meaning |
|---|---|---|
| **connected app** | peer | Anything with its own sign-in to your Kitebook: an assistant (Hark, Claude.ai, ChatGPT), a coding agent (Claude Code, Codex, Pi) or your Mac's runner. Revoke one on /start → Status. |
| **runner** (on **your Mac**) | runner | The small Kitebook program on your Mac (or another computer) that runs coding tasks after you approve them. "Connect your Mac" installs it. |
| **workspace** | space | One shared set of files, tasks and notes. A new account has one, called `main`. The config key and API field stay `space`. |
| **what it can do** / **access** | grant, verbs, scope | The permissions a connected app has: read, write, delete, **send tasks** (the `dispatch` verb), each limited to some folders. |
| **safe default access** | preset | The access /start invites give unless you change it: assistants and coding agents read everything, send tasks, and save files only in `shared/` and `kb/` (the consent and pairing pages' recommended choice, *Read everything, save to shared memory, send tasks*, is the same, with each task approved); the runner uses `tasks/`, `shared/`, `repos/` and `kb/`. |
| **folder** (`shared/`) | `shared/**` glob | Where access applies. On a form, `**` means every folder and `shared/**` means the shared folder and everything in it; the page says so next to the field. |
| **send a task** | dispatch | Ask a runner to do coding work. |
| **permission** / **run on its own** | policy, standing trust, signed auto-run | What you let an app do without being asked each time (/settings → Connected apps): run tasks in some projects, push, until a date. Your browser signs it; your Mac checks it. |
| **hold on a task** (timed out) | lease (expired) | While a runner works on a task it keeps renewing its hold; if it disappears, the hold times out and the task is retried or failed. |
| **knowledge base** (`kb/`) | KB | Shared notes all your agents can search. |
| **invite link** / **install command** | invite code | A one-time link (Hark) or Terminal line (your Mac) from /start that connects one app. |
| **recovery code** | master key, admin token | Your account's master key, only for recovery: you sign in with `kitebook open`, a passkey or a request you approve on your Mac. Shown under "Use a recovery code" / "Save a recovery code"; the API field `admin_key` and `KITEBOOK_ADMIN_TOKEN` keep the old name. |
| **passkey** | WebAuthn credential | A sign-in key on your phone, laptop or password manager (or a security key). Added under /start → Sign-in. |
| **signed-in browser** | remembered browser, trusted device | A browser that stays signed in for 30 days, renewed each time it is used (listed and removable in Settings → Devices & passkeys). |
| **sign-in token** | bearer token | What a coding agent's one-line command stores so it can reach the server. |
| (not shown) | DO, Durable Object | Storage detail of the Cloudflare deploy; never on a user screen. |

Words that stay as they are because people type them: command names (`runner.ts doctor`, `kitebook login`), flags (`--space`,
`--scope`, `--peer`), config keys (`"space"`, `"access"`, `"approve"`) and folder paths. When one appears in a sentence,
the sentence says what it is ("set `"space"` in runner.json to one of: main").
