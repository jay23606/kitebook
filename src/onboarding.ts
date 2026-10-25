// One URL is enough for assistants that can fetch instructions and make authenticated HTTP calls.
// This request contains no credential; the owner still approves the existing pairing flow.
export const connectionPrompt = (o: string) => `Connect to my Kitebook at ${o}. Read ${o}/setup.md. Prefer your platform's native MCP/custom connector and secure credential system; use a script only when native integration is unavailable. Show me the approval link; I will approve it myself. Verify access and report whether setup will survive a sandbox restart. Keep any working connection until its replacement passes. Do not ask for my password, recovery code or tokens in chat.`;

export const MUSE_CONNECTOR_NOTE = "Muse: reuse your native stored credential and existing custom.kitebook connector helper when available. Set User-Agent: muse-custom-connector/1 on its MCP HTTP transport, including initialize, tool calls and reconnects; keep the host's secure credential reference and let it supply Authorization. Some Cloudflare deployments reject Python's default user agent with HTTP 403 / error 1010: that alone does not establish invalid credentials or a Kitebook permission denial. Do not re-pair or rotate credentials for this error; if the identified client is still blocked, report it to the owner and stop. For Muse's clientid naming prompt, tell the owner: When Muse asks for clientid, enter the name you want this connection to use; it can be any name you choose. Ask which name they want. Keep that local label separate from the OAuth client_id returned by registration. Verify the actual peer and permissions with whoami; separate native and device-flow connections can have different grants.";

export function dailyGuide(o: string) {
  return `# Kitebook: setup guide for agents

Kitebook shares notes, original files and handoffs between the owner's daily assistants. Coding tasks are optional. Configure this connection yourself where your platform allows it; the owner only approves access.

1. **Prefer your platform's native connection.** Reuse a working Kitebook connection and call whoami. An expired access token needs a refresh, not another pairing request. If your host manages MCP OAuth or custom connectors, use its authorization-code flow with PKCE and resource=${o}/mcp. Discover the authorization server and registration_endpoint from ${o}/.well-known/oauth-protected-resource/mcp and its authorization-server metadata. Retain the client_id returned by registration; use the platform's actual redirect URI and secure credential reference, never an invented callback or a token file in the sandbox. Let the host manage sign-in and refresh. A registration refusal needs the owner's attention, not a retry loop or a silent fallback. If you cannot configure integrations or make HTTP calls, give the owner the MCP URL and explain the limit.
2. **Device-pairing fallback.** Only when native integration is unavailable, POST ${o}/connect with Content-Type: application/json and {"agent":"<your platform, e.g. hark or muse>","name":"<your own name>"}. No client ID, registration or admin key is needed. Show the owner verification_uri_complete and user_code. They open the link and approve; never open or approve it for them, ask for their password, or read a recovery code. If native setup failed, report its error first; do not silently replace a working connection. A host-managed connection skips steps 2–4: never extract its secrets.
3. **Wait within the returned deadline.** POST the returned token_endpoint with Content-Type: application/x-www-form-urlencoded and grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=<device_code>. Wait at least interval seconds between attempts and stop after expires_in seconds. authorization_pending means keep waiting; slow_down means increase the interval by at least 5 seconds and honor any longer interval in error_description or Retry-After. Stop on access_denied, expired_token, invalid_grant or other terminal errors. On timeout or an uncertain response, report the state instead of repeatedly creating connections.
4. **Keep the connection outside the disposable sandbox.** Save the endpoint, access_token, refresh_token and expiry in your platform's persistent secret/integration store. Use Authorization: Bearer <access_token>, never a URL query, chat message, shared file, KB note or skill containing secrets. A skill may hold instructions and a secret reference only. Refresh at ${o}/token with grant_type=refresh_token&refresh_token=<saved token>; serialize refreshes and atomically replace the old refresh token with the new one. Never replay an old refresh token. If a refresh response is lost, stop and explain that reconnecting may be needed. If no persistent secret store is available, explain that setup is temporary.
5. **Verify before reporting success.** POST ${o}/v1/whoami with the Bearer header and {} as JSON. Check the actual workspace and permissions. With MCP, initialize ${o}/mcp then fetch tools/list; with plain HTTP use GET ${o}/v1 for operation schemas. Call mcp_status, then a bounded kb_search for the current project. A saved configuration alone is not a verified connection. Report the connection name, what it can do, and whether credential persistence was confirmed or remains unverified. Do not print credentials.
6. **Continue the work.** Read relevant shared knowledge before a task. Publish selected decisions using kb_add; use a stable key to update a correction. Keep datasets and original files alongside a short handoff. For a new sandbox, recover published files with sync/sync_read and acknowledge only after applying all pages and deletions. Never reuse a checkpoint without its local files. Unpublished local work cannot survive sandbox loss. Do not create a test coding task or start a schedule unless the owner asked.

### Muse native connector

${MUSE_CONNECTOR_NOTE}

When Muse asks for \`clientid\`, explain: "Enter the name you want this connection to use. It can be any name you choose, for example Muse research. What name would you like?" Use the chosen label for the connector's name and client_name when registering. Keep the OAuth client_id returned by registration unchanged. Reuse the existing connection without asking again on every restart. After approval, report whoami's actual name and can sentence, tools/list and mcp_status results; do not assume a peer name, tool count or server version. Keep helper code and setup notes in the platform's persistent workspace, using a credential reference rather than embedding tokens. Verify recovery from a fresh sandbox separately before claiming it survives resets. A helper using the native credential is still the native route, not a reason to pair again.

For an end-to-end check, ask the owner for a harmless note to save, read it back, then have a second assistant read it. Only test writes allowed by the owner's grant. If a write is denied, explain the permission needed; do not broaden it yourself.

On activation or sandbox restart, load the persistent connection, refresh if necessary, call whoami and mcp_status, then recover the relevant workspace. A stored inbox acknowledgement is not a file cache. Check tools/instructions revisions before saving new ones. A stopped sandbox still needs its platform's wake mechanism.

If the endpoint is unreachable, distinguish DNS/TLS/network failures from sign-in or permission errors. A provider may reject shared tunnel hostnames even when the owner's Mac can reach them. Ask the owner to check Settings → Connection or use a stable accepted hostname. Never request the owner's Cloudflare credentials or change their domain automatically.

Full operation schemas: ${o}/v1 and ${o}/openapi.json. Detailed protocol, synchronization and optional coding tools: ${o}/llms.txt.
`;
}

// Getting started is complete with a connected app and published context; a coding runner is optional.
export function setupState(st: any) {
  const spaces: any[] = st?.spaces ?? [], peers = spaces.flatMap(x => x.peers ?? []);
  const mac = peers.some(p => p.kind === "runner" && p.online);
  const agent = peers.some(p => (p.kind === "assistant" || p.kind === "coding_agent") && !p.never_connected);
  const shared = spaces.some(x => x.has_shared === true);
  const task = spaces.some(x => (x.done_tasks ?? 0) > 0 || (x.recent ?? []).some((t: any) => t.state === "succeeded"));
  return { mac, agent, shared, task, all: agent && shared };
}
