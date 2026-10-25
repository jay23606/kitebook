# How to use Kitebook

Kitebook is a shared workspace for your daily assistants, such as Hark and Muse. Use it to continue research, analysis and other ongoing work across platforms without repeatedly moving the same context. Local coding agents are optional.

## 1. Give your assistant your Kitebook URL

Install Kitebook using the [quick start](quickstart.md). In **Settings → Connection**, enable public access and copy **the public address** or **Copy connection request**. A cloud assistant cannot reach your Mac's `127.0.0.1` address.

Paste this into your assistant, replacing the example address:

> Connect to my Kitebook at https://kitebook.example.com. Read its /setup.md instructions and configure the connection using your supported tools and persistent secret storage. Show me the approval link. After I approve, verify access and tell me whether the connection will survive a sandbox restart.

The assistant should use its platform's native MCP/custom connector and secure credential system when available. If that platform lacks a native integration, an assistant that can fetch URLs and make HTTP requests can use device pairing instead. **You open the link and approve the access yourself.** The assistant does not need your password or recovery code. It can use MCP or the HTTPS API; a local coding runner is not required to share context. A failed native setup should be explained before choosing a fallback, while an existing working connection stays intact until its replacement is verified.

Some platforms only allow integrations through their settings. In that case, add `https://kitebook.example.com/mcp` as a custom MCP connector and follow its sign-in flow. If the platform only supports a static app key, use **Settings → Connected apps → Add an app**, and enter the key through the assistant's secure credential interface. Never paste it into an ordinary conversation.

### Muse's native connector

When Muse offers `credentials.request_api_access`, prefer that supported credential flow over a script with a sandbox-local token file. Use provider `kitebook`, authorization-code OAuth with PKCE, and `resource=https://kitebook.example.com/mcp`. Discover `registration_url` from the authorization server's `registration_endpoint`; keep the real client ID returned by registration and use Muse's own redirect URI. Reuse an existing `custom.kitebook` helper when available, with Muse's secure credential reference/surrogate supplying authentication.

**When Muse asks for `clientid`, enter the name you want this connection to use—it can be any name you choose**, for example `Muse research`. Muse should explain this and ask which name you want. Use that label for the connector's name and registration's `client_name`; keep the separate OAuth `client_id` returned by registration unchanged. Reconnecting an existing connection should reuse its name and credential without asking again.

**Set the template client's MCP HTTP transport header to `User-Agent: muse-custom-connector/1`**, including initialization, tool calls and reconnects. In the owner's Muse deployment, Python's default user agent received Cloudflare HTTP 403 / error 1010; the same native credential succeeded after this header change. Cloudflare documents [error 1010 and descriptive application user agents](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/). Preserve the secure credential reference; this transport fix does not require a new device pairing or credential rotation. If it still receives 1010, report the upstream block to the owner and stop. A Kitebook JSON permission denial needs the owner's access decision instead.

After approval, verify `whoami`, MCP `initialize` and `tools/list`, `mcp_status`, and a bounded `kb_search` through the **native credential**, not a leftover device-flow credential. Report the actual peer name and `can` sentence. Different connections can have different grants; never assume a particular peer, tool count, version or write access. Keep the working helper and its instructions in Muse's persistent workspace, without embedding secrets. Recovery in a fresh sandbox still needs a separate check. A 201 registration response alone is not a working connection. Keep an existing working integration until its replacement passes verification. If registration is refused, report the server's policy error to the owner; do not repeatedly register or silently switch authentication methods.

If a provider refuses the hostname, follow the [domain guide](domain.md). A working connection from your Mac does not establish that Hark or Muse can reach it.

## 2. Check sharing with one harmless note

Tell the first assistant:

> Save a project note in Kitebook: the weekly research report should include the original dataset and its sources. Read it back and tell me where you saved it.

Connect a second assistant and ask:

> Check Kitebook for the weekly research report instructions. Tell me what you found and where it came from.

The second assistant should retrieve the saved note. This checks the workflow you need, beyond an integration merely appearing in a client. Choose a non-sensitive example, and stay within the permissions you approved. If the assistant has read-only access, saving is expected to fail; change access yourself only if you want it to write.

## 3. Continue real work across assistants

Before switching platforms, ask the current assistant:

> Publish the source files and current results to Kitebook. Leave a handoff with the goal, what is finished, the next step, open questions and the sources used. Tell me when publication succeeds.

In the next assistant:

> Read the latest Kitebook handoff for this project, recover the linked files and continue with the next step. Check for newer decisions before acting.

Keep original CSV, JSON, documents and other artifacts alongside the short handoff. A summary alone cannot reproduce a dataset or recover a file. The [workspace protocol](workspace-sync.md) publishes related files and a handoff together, and refuses stale writes rather than silently overwriting another assistant's changes.

Kitebook does not observe every conversation on other platforms. Assistants must use the connection to read and publish selected work. Instructions help them do this consistently; vendor support determines whether hooks, scheduled runs and automatic wake-ups are available.

## 4. Correct outdated knowledge

> The report now runs on Monday, not Friday. Update the existing Kitebook decision, preserve its source and history, and tell me which entry changed.

The assistant can update a note using its stable key or edit the existing file. Ask another assistant to retrieve the latest version. Corrections should replace or supersede the outdated decision deliberately; saving a second contradictory note does not resolve it.

You can inspect, search and edit notes yourself in **Library**. Open a note's **Source & version history** to see provenance and retained versions. Use **Files & handoffs** for the original artifacts.

## 5. Resume after a sandbox reset

> Load your saved Kitebook connection, verify access, and recover this project's published files and latest handoff. Continue only after checking what is already finished.

Credentials must live in the assistant platform's persistent integration or secret storage, outside its disposable sandbox. A skill can store connection instructions and a reference to a secret; it must not contain the secret itself. If the platform cannot persist credentials, reconnecting after a reset may be necessary. The assistant should report that limitation during setup.

Published files can be pulled into a fresh sandbox. Unpublished edits cannot. An old sync checkpoint without its local files needs a fresh snapshot. A stopped assistant still needs its platform to wake it; Kitebook cannot wake an unsupported vendor sandbox.

Keep the Kitebook server's storage persistent too, and maintain an independent backup. [Recovery and backup details](workspace-sync.md#durability-and-backup).

## Optional: ask a coding agent for help

When a task needs repository access, builds or tests, connect a coding runner from **Connection options → Coding runner**. Then ask your daily assistant to inspect or delegate work using the projects that runner reports. New coding work follows your approval settings. Existing coding sessions have separate permissions; connecting an assistant does not grant session access.

For example:

> Use the project notes in Kitebook to ask my coding agent to investigate the import failure. Report its findings before requesting changes.

See [agent tools and permissions](agents.md) and the [security model](security.md). You can manage an assistant's access under **Settings → Connected apps**.

### Sign in from your phone

Enter your **Kitebook master password** on the sign-in page once. Your Mac checks it in the background; keep the Mac awake and its runner connected. No macOS Keychain password is required. Passkeys are optional under **Other ways to sign in**. If remote password approval is disabled, use **Send a sign-in request**, then run `kitebook approve <code>` on your Mac. An expired request needs a fresh code.
