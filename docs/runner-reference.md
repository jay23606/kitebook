# Runner command and configuration reference

This reference accompanies [`client/runner.ts`](../client/runner.ts). See [the runner guide](runner.md) for setup and approval behavior.

```text
Local runner (your Mac). Dials OUT to the server over one WebSocket, so no ports are opened.
Turns tasks addressed to it into local coding-agent runs, but only after YOU approve here, on this machine.
  bun runner.ts init <kitebook-url> <invite-url> [--name mac] [--roots ~/code,~/work]   first run: claims the invite, writes ~/.kitebook/runner.json (0600)
  bun runner.ts doctor <runner.json> [--test-push]   check url, token, agents, projects, approvals (really probes the ntfy server), launchd, runner integrity, kb sync;
                                         prints the fix for each problem. --test-push also sends a test notification to your phone
  bun runner.ts kb detect <runner.json> [--apply]   find agent instruction files (Pi/Codex/Claude/repo AGENTS.md...) and propose kb.sync entries
  bun runner.ts runner.json              run in the foreground
  bun runner.ts install runner.json      macOS: start at login, restart if it dies (launchd)
  bun runner.ts uninstall [runner.json] [--purge]   (default: ./runner.json, else ~/.kitebook/runner.json) stop + remove the launchd job; --purge also revokes this runner's token on the
                                         kitebook (revoke_self) and deletes ~/.kitebook (cursors, sessions, logs), ~/.kitebook-kb (KB cache) and the log file
  bun runner.ts service runner.json status|restart server|runner|all|update|pin <sha|version>|stop|start|logs   Kitebook's own services
                                         (the owner: kitebook status / restart / update / logs / stop / start; agents: kitebook-svc ...)
  bun runner.ts passkey register|list|remove runner.json   passkey for phone approvals (one-time link)
  bun runner.ts trust add|remove|list runner.json <peer> <pubkey>   trust a dispatcher's signing key (signed auto-run)
  bun runner.ts approve [runner.json] [<task|code> yes|no]   approve at this computer (lists what waits; no phone needed)
  bun runner.ts open [--print] [--settings]   open /start (or Settings) in the browser, signed in and trusted by this Mac (single-use 5-minute link)
  bun runner.ts connect [runner.json] [pi codex claude cursor gemini opencode | --all] [--detect]   let your coding agents use Kitebook (their own folder, no task sending)
  bun runner.ts release-key create|show|rotate [--repo dir]   the release key, kept in the OS keychain; bun runner.ts release sign [--repo dir]
  bun runner.ts set runner.json approve phone   change a setting; a running runner picks it up within seconds (no restart)
runner.json:
{ "url": "https://kitebook.example", "token": "rk_...", "space": "main",
  "approve": "dialog",                         // unset = "dialog" on macOS ("dialog+phone" when ntfy is set), "phone" elsewhere if ntfy is set, else terminal with a TTY, else "browser" (doctor warns);
                                               // "dialog" (macOS), "phone" (push to your phone), "dialog+phone" (whichever you answer first), "terminal", "browser" (/start Status or kitebook approve; init's default off macOS), "auto" (no prompt; FYI to ntfy if set)
  "approvePasskey": false,                     // true: phone approvals must be signed with your passkey (bun runner.ts passkey register runner.json)
  "trusted": ["hark"],                         // optional with approve=auto: only these peers run without a prompt (others fall back to dialog)
  "requireSignedAuto": true,                   // approve=auto only for tasks signed by a key in trustedKeys; anything else asks you (client/sign.ts)
  "trustContextFiles": false,                  // true: signed auto-run tasks also get CONTEXT.md + context/<project>.md (unsigned; off by default)
  "trustedKeys": { "hark": ["ed25519:..."] },  // dispatcher public keys: bun runner.ts trust add runner.json hark <pubkey> (from: kitebook keygen)
  "ownerKeys": ["p256:..."],                   // the browsers this Mac trusts (Settings): only permissions they signed let a task run on its own
  "trustedKbAuthors": ["hark"],                // KB notes a signed auto-run may see: only these authors (+ this runner); unset = trustedKeys' peers + this runner.
                                               // Notes by others (a Codex token, a chat assistant) are dropped and audited; approved runs see them labeled untrusted
  "access": "worktree",                        // "worktree" (agent told to stay in its worktree) or "full" (agent may use the whole machine)
  "defaultAgent": "pi",                        // agent for tasks with no project / project "home" (run in a scratch dir)
  "ntfy": { "topic": "kitebook-<long random>", "server": "https://ntfy.sh", "token": "tk_..." },  // for phone approval: install the ntfy app, subscribe to the topic
  "keepAwake": true,                           // install: run under caffeinate so the Mac doesn't sleep while plugged in
  "agents": { ... }                            // optional: built-in pi, codex, claude, gemini, cursor, copilot, opencode, grok cover the usual CLIs.
                                               // custom: "mine": ["my-agent", "--prompt", "{prompt}"]; {session} = a per-branch session file
  "projects": { "myapp": { "path": "/Users/you/code/myapp", "agent": "pi", "verify": ["bun test"],
                 "push": "ask",        // after a task: "ask" (approve the push here), "never" (default), or "auto"
                 "remote": "origin",   // any git remote: GitHub, Gitea/Forgejo, a bare repo over ssh...
                 "pr": true,           // GitHub remotes: open a draft PR with `gh` after pushing
                 "mirror": true } },   // keep repos/<name>/ in the space = this checkout (tracked + untracked, minus .gitignore and secrets)
  "mirrorEvery": 30,                   // seconds between mirror scans (only changed files are sent)
  "env": ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],   // passed to the agent locally, never synced
  "envFile": "~/.kitebook/agent.env",   // optional KEY=value file for those keys (launchd doesn't load your shell)
  "claudeApiKey": false,               // live Claude Code (client/live-claude.ts) drops ANTHROPIC_API_KEY so it runs on your Claude plan; true = bill that key
  "askAuto": true,                     // quick asks (op ask, read-only, client/runner-ask.ts) from your own apps answer without asking; false = ask every time
                                       // (asks to an agent with no read-only mode, e.g. grok, always ask unless "askAutoAnyAgent": true)
  "askIdleMin": 10, "askMaxSessions": 4,  // warm quick-ask sessions: closed after this many idle minutes; at most this many alive
  "askAgents": { "mine": { "argv": [...], "protocol": "pi" | "claude" | "exec" } },  // read-only ask mode for a custom agent (presets: pi, claude, codex)
  "maxParallel": 3,                    // agents running at once (never two on one project checkout); approvals don't take a slot
  "models": { "codex": ["gpt-5.5"] },  // optional extra models per agent (pi's list is read from `pi --list-models` at startup); cursor, copilot
                                       // and grok advertise no list, so an explicit model for them is passed through as given (with a log line)
  "live": true,                        // live agent connections (client/live-driver.ts): Codex as one `codex app-server` session per task, so a steer
                                       // reaches the running turn and cancel interrupts it; false (or {"codex": false}) = one CLI run per turn as before
  "codexApprovals": "never",           // live Codex: "on-request" lets it ask before leaving its sandbox; you answer (never auto), no answer = no
  "liveApprovalSec": 300,              // how long such an ask waits for you before it counts as no
  "liveEvery": 10,                     // seconds between live status/log uploads while an agent runs (task_status, tasks/<id>/live.log)
  "presenceEvery": 30,                 // heartbeat for Who's working (op presence): what this Mac is on; it reads offline after missing one
  "repairRounds": 2,                   // a red explicit verify gets this many automatic fix rounds in the same agent session (per project too; task limits.repair_rounds)
  "contextMaxChars": 12000,            // cap on the project context (CONTEXT.md + context/<project>.md) put in each agent prompt
  "maxMinutes": 30,                    // per agent turn
  "kb": { "sync": [{ "path": "~/.pi/agent/memory", "scope": "global", "origin": "pi-memory" },   // shared knowledge base (src/kb.ts):
                   { "path": "~/code/myapp/AGENTS.md", "scope": "project:myapp", "exclude": ["drafts/**"] }],  // these local memory files are
          "every": 60,                // chunked, redacted and published read-only (key = path#chunk; removed chunks are forgotten). A default
          "cache": "~/.kitebook-kb/kb",     // denylist skips USER.md, people/, *address*, *personal* ... unless "include" names them. The KB is mirrored
          "ollama": { "model": "nomic-embed-text" } } }  // to "cache" for offline grep (false = off); optional local embeddings.
  Idle cost is ~0: unchanged files aren't re-read (stat cache), edits diff against ~/.kitebook/<name>.<space>.kb-manifest.json (a full
  kb_list only on first run / lost manifest / every "reconcileHours", default 6), and the cache follows kb/ events with a safety pull every
  "pullEvery" seconds (default 900).
init / `kb detect <cfg> [--apply]` propose entries for agent instruction files (Pi, Codex, Claude Code, repo AGENTS.md...; origins pi-memory,
codex-memory, claude-memory, repo-agents); an entry's "only": ["**/SKILL.md"] narrows a dir to matching files.
Tasks arrive with kb_context (top KB hits for the goal), which goes into the project context pack; learnings the agent writes to
.relay-learnings.md land in context/<project>.md, which the KB indexes (kind learned, origin task:<id>).
An agent that needs the sender ends its turn with a line [relay-question: ...]: the task parks in needs_input (no lease, slot freed,
FYI to ntfy if set) and the sender's task_answer resumes the same worktree, branch and session file.
```
