# Changelog

## 0.0.1 — first public preview (2026-10-23)

The first public release of Kitebook (it had an earlier name during private development). It works end to end for the maintainer every day, but it is early: expect bugs, rough edges and breaking changes before 0.1.

### What's in it
- A personal knowledge base every agent reads and writes, with a summary of what each task did and what agents learned.
- An MCP server your personal assistants (Grok bot, Hark, Muse; Dots unverified) connect to by URL, with OAuth and per-app permissions. Any other MCP client can connect too.
- Tasks that run on your own computer after you approve them, in a git worktree, and come back as a branch, diff and test results.
- Coding agents: Pi, Codex, Claude Code (most tested); Gemini CLI, Cursor, GitHub Copilot CLI, opencode, Grok CLI (less tested).
- Approvals on a Mac dialog, phone, browser or `kitebook approve`; signed tasks for pre-approved apps.
- A shared knowledge base and shared folders between assistants and agents.
- Self-hosting on your Mac (workerd), Docker, or Cloudflare Workers.
- macOS (main target), Linux and Windows 10/11.

### Known issues
- **Updates from an assistant update the runner only.** After `relay_update` reports "updated, health ok", a server running on the Mac (workerd) can still be on the old code until you restart it (`kitebook restart server`).
- **Shared KB files on Windows:** the KB cache can stay empty, and `kitebook kb export` doesn't yet check that a file path stays inside the target folder (a fix is in progress).
- **Stored paths** can contain `\`, NUL or control characters; every client that writes them to disk has to re-check them.
- **KB cache and export follow a symlink** that a local process planted inside the folder.
- **Codex quick asks on macOS** were failing inside the runner's read-only sandbox; fixed, but not yet confirmed on many Macs.
- **The guard is not a sandbox.** It blocks common mistakes; an agent that tries can get past it.
- **Linux and Windows presence checks** are enforced by Kitebook's own code, not the hardware; a coding agent running as you could read that key file.
- **Agents other than Pi, Codex and Claude Code** are less tested; their CLI flags change often.
- **Single owner only.** Teams and shared workspaces aren't built yet.
- **Not built yet:** a real OS sandbox under the guard, the runner refreshing OAuth tokens itself, the S3 blob driver tested against a live bucket, and a demo recording with a real agent.

Found something else? Please [open an issue](https://github.com/um1b/kitebook/issues/new/choose).
