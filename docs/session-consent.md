# Coding-session consent

Connected daily assistants can search and read saved coding conversations and request continuations by default. Use **Settings → Connected apps → Your coding sessions** to choose Off, read-only access, or a saved project scope. Explicit restrictions remain authoritative. The Mac still verifies its trusted owner-signed policy before reading.

To save a narrower permission, choose one or more projects and a capability:

- **Read:** search, read recent messages and inspect recorded session metadata within those projects.
- **Continue copies:** also start work from a copy, leaving the source conversation unchanged.
- **Continue idle originals:** also continue an original when the native agent confirms it is idle. Running sessions and sessions whose activity cannot be confirmed use a copy.

For coding work choose **Within these limits, without asking again** or **Ask each time**. Reading follows the saved project scope. Work outside that scope, or using an original beyond the saved capability, asks for a single task approval. Task autorun never bypasses session consent. Execution still respects the runner's project allowlist, task signatures and other approval gates (such as pushing or spending).

Permissions are an owner-signed policy bound to that app's connection and revocation epoch. They are stored on Kitebook; the runner independently verifies the signature, current connection and actual source folder. No manual JSON editing is needed. Older runners see session access as off until updated. Existing explicit legacy grants remain compatible until revoked or replaced.

**Disconnect** is visible on the app card. It ends that app's credentials and listeners and cancels its queued/running Kitebook tasks. Stopping a native subprocess is best effort; completed external side effects cannot be undone. User-started native sessions, shared knowledge, prior write attribution and audit history remain. Cached credentials stop authenticating. Reconnecting or rotating credentials invalidates the old session consent; choose a new scoped permission for the new connection, or deliberately restore the enabled default.

Search filtering happens before snippets are read, and permissions are checked again before responses or task execution. Native transcript files are never edited by a copy operation. Audit records include reads, changes to permission, automatic work and cancellation, without copying search text into the audit log.
