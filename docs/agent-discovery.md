# Agent discovery and MCP updates

A runner (computer), an authenticated app/peer, an installed coding CLI and a native coding-agent conversation are different things. `presence` reports runner tasks and explicit agent heartbeats; an idle runner does not establish that Codex Desktop has no open conversation.

## Models

Call `agent_models {runner:"mac", agent:"codex", refresh:true}` before choosing a model when the advertised catalog is stale. Without refresh this reads the advertisement; offline/older runners return cached evidence and a refresh status. Native discovery is coalesced, cached for 15 minutes, and refresh calls are limited to one attempt per agent every five seconds. Each native process is bounded in time; command output and pagination have size limits. Discovery never starts a coding turn.

Each catalog includes `source`, `checked_at`, `attempted_at`, `expires_at`, `stale`, `authoritative`, and model entries with their own source/default flag. Native Codex discovery uses initialize/initialized and model/list, including pagination. [Codex's model list can be bundled or cached and is not an entitlement check](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server). `availability:unknown` is deliberate. A successful task or provider API response is different evidence.

An explicit `agents.<agent>.models` configuration or a successfully discovered owner-configured `listModels` command imposes a model-membership constraint. Built-in native catalogs and legacy fallback ids do not reject newer model names. A failed custom list command returns stale/unknown evidence rather than treating an unavailable catalog as a valid allowlist. Owner allow/deny rules always apply. `models` additions are suggestions, not a membership allowlist. An empty explicit catalog permits the CLI default but refuses an explicit model. Adapters without native listing return unknown/fallback; Kitebook does not invent account access or copy model names from another provider. Describe's compatibility `models` arrays remain available; use `model_catalogs` for provenance.

## Conversation status

`session_status {runner:"mac", agent:"codex", session_id:"<native id>"}` uses the same trusted owner policy and per-app session setting as `sessions_search` and `session_get`. Both server and runner recheck access before delivery. It returns metadata and recorded model evidence; no messages, snippets or transcript text leave the runner. Store formats without model metadata return null. Model selection records and last-turn records are labeled separately and never claimed to verify the current model. Recent file writes establish activity, not that a turn is still busy; `busy` is unknown.

Supported stores: Codex, Claude Code, Pi, Gemini CLI, Copilot CLI, opencode and Cursor. Read the native id from sessions_search; a task id or peer name is not a native conversation id. Model extraction is bounded to the recent 256 KiB (or bounded compressed rollout). A large JSON store or old selection outside that window can return unknown. No transcript search index is written by status.

## Refresh after updates and sandbox restarts

Daily agents should keep credentials and the *last applied* revisions in their platform's persistent credential/config store. A restarted sandbox must restore that state and check again; an in-memory flag does not survive a restart. Never save tokens in the shared knowledge base.

1. At connection startup, after sandbox restart, and on the next turn after an update hint, call `mcp_status` with saved `known_tool_revision` and `known_instructions_revision` (omit on first use).
2. Changed or unknown revisions require fetching tools/list and reinitializing/reconnecting through the host's supported mechanism, so tools and owner instructions are actually applied. The revisions describe the caller's actual tool descriptors and initialized instructions, including its brief. Session grants and schema changes alter the tool revision; brief changes alter the instructions revision.
3. Save revisions only after the host applies them. The check itself returns `applied:false`; it cannot hot-reload an arbitrary host, upgrade a CLI or acknowledge for it. Hosts that cannot refresh need a new connection/session. Existing stateless transport does not advertise server-pushed listChanged notifications.

`kitebook mcp check` provides the same authenticated check; pass `--known-tool-revision` and `--known-instructions-revision` for comparisons. Generic HTTP `/v1/mcp_status` also works. MCP initialization metadata and describe point to this lifecycle.

Local `/health` keeps its `{ok:true}` body and adds X-Kitebook-Build and X-Kitebook-MCP-Revision headers. The revision is a cached public-contract fingerprint, not the per-app manifest. It never reads a Durable Object or probes native agents. The public edge exposes neither header. Do not poll health on a tight timer; check once at startup/next turn and use authenticated mcp_status to resolve a changed marker. A server check does not prove an installed runner or a host's cached tools updated.

### Applying updates
The stdio bridge now advertises tool-list change notifications. Before a tool call it checks the caller's contract at most once per minute, coalesces overlapping checks and does no idle polling. The host must fetch `tools/list` to apply new descriptors. Changed server instructions require reinitializing/reconnecting; the bridge reports that explicitly and never labels an unseen revision applied. Token files are reread per request, so rotating a file does not require restarting the bridge. Requests have deadlines and response/concurrency limits; ambiguous writes are never automatically replayed.

For direct remote MCP connections, run `mcp_status` at startup, after sandbox restart and before the next turn following an update. Use the host's supported reconnect/refresh action. Codex app-server exposes `config/mcpServer/reload` for the process owning that connection ([official documentation](https://learn.chatgpt.com/docs/app-server)); running a separate app-server cannot refresh Codex Desktop's existing process. Other assistants may require manual reconnect. Keep the endpoint and credential in the provider's persistent connector settings, not only in an ephemeral sandbox; a rebuilt sandbox should pull its workspace replica before working and publish its handoff before disposal.

### Failure bounds
Runner HTTP calls have a 30-second deadline and preserve cancellation. Recurring advertisements and presence coalesce; malformed intervals fall back to safe defaults. Reconnect delays increase with jitter up to one minute and reset after a stable minute online. Webhook delivery retains its finite retry budget. Blob deletion failures back off persistently and pause after eight failed sweeps; `usage.gc.retry_paused` identifies that state, and the operator's `admin.ts gc <workspace>` retries it. These are operation bounds, not an account-wide monetary spending cap.

`kitebook mcp diagnose` makes at most one health and one identity request, with deadlines and no automatic redirects/retries. It reports the client vantage point and keeps provider policy unknown. Settings → Connection shows the reported Hark restriction and unverified Muse/Tailscale path. Neither turns on public access or changes the owner's connection. CLI quick asks use bounded long polls with a minimum retry interval instead of four status calls per second.

The bridge forwards one JSON-RPC 2.0 request or notification per line. Notifications produce no stdout response, including when HTTP fails. Invalid envelopes and unsupported batch arrays return `-32600`; malformed JSON returns `-32700`. A 401 returns a reconnect/token-renewal hint without exposing the remote response body. A dropped response never automatically replays a write; check its outcome before retrying. Transport behavior follows MCP's [single-message transport contract](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports).

Session tools are enabled by default (Search, read and send). Explicit Off and read-only choices remain effective, including after task/folder settings change. The Mac still verifies the signed owner policy and rejects missing, unpinned, tampered or rolled-back policies. A session continuation follows task permissions and approvals; owner conversations use a copy by default and writing into the original always asks. Refresh tools/list after updating to discover the new default.
