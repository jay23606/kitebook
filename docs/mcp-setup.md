# Coding-agent MCP setup

Settings → Coding agents → Connect sends an owner-signed command to your computer. The runner checks the signature and calls the same adapter as `kitebook connect <agent>`.

- **Codex:** native Streamable HTTP entry plus an Authorization header in `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`), mode 0600. Desktop and CLI share this configuration; no shell token export is needed.
- **Pi:** native `pi mcp add` with a token environment variable, saved in `~/.kitebook/agent-tokens.env`. Open a new terminal before starting Pi. Old versions without `pi mcp` are refused before any token is minted.
- **Claude Code:** user-scoped native `claude mcp add`, including the HTTP Authorization header.
- **Cursor, Gemini CLI, opencode and Copilot CLI:** merge only Kitebook's entry into their JSON configuration, preserving other servers and settings. Invalid JSON or a malformed server map is refused before minting or rotating a token.
- **Grok Build:** native HTTP MCP registration. A different `grok` CLI without header support reports an error.

A successful button result means configuration was saved. Reload the agent's MCP servers or restart its app to connect; it does not prove that an already-running client refreshed its tools. Network, authentication or vendor restrictions can still prevent that client's handshake.

Validation uses temporary profiles. Native Claude Code and Pi registration/discovery completed authenticated MCP handshakes against a local synthetic server, without inference. Native Codex read back its saved HTTP header with the shell token variable absent. The remaining adapters have isolated fixture coverage; this is not evidence of live vendor authentication for those clients.
