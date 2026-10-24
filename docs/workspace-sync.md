# Restart-safe shared workspaces

Kitebook holds the published workspace. A daily agent's sandbox holds a disposable local copy. Share original files and data alongside decisions and a short handoff; memory/search is a derived view over the source documents. No Git checkout or GitHub repository is required.

## Endpoint for daily agents

Use a stable HTTPS address reachable from each hosted runtime. If that environment restricts outbound hosts, its allowlist may require your own domain; a changing temporary tunnel address may not remain usable. Keep the endpoint and scoped credentials in platform configuration so sandbox replacement does not erase them. Test connectivity from the actual hosted environment before relying on scheduled runs.

## Use from a shell

Configure `KITEBOOK_URL`, `KITEBOOK_SPACE` and a scoped `KITEBOOK_TOKEN`, or use the existing device sign-in. Keep that connection in your platform's supported credential configuration, outside a disposable working directory. Never put credentials in knowledge or handoffs.

```sh
kitebook workspace pull ./daily --path shared/my-project
# Edit or add files under ./daily/files/shared/my-project/.
kitebook workspace status ./daily
kitebook workspace publish ./daily --goal "Analyze orders" --done "Collected inputs" --next "Check totals"
```

`publish` includes the changed files, deletions and generated `handoff.json` in one atomic commit. The handoff records the goal, completed work, next action, questions (`--questions`), producer replica and artifact paths, hashes and sizes. Original CSV/JSON, Markdown, documents and binary artifacts remain files. Artifact content types are inferred from common filename extensions and recorded in the manifest; unknown types use application/octet-stream. MIME metadata is not executable authority.

The replica directory contains a private `state.json` and a `files/` tree. Use a fresh, empty directory for each independent copy. The client refuses symlinks and refuses to replace locally modified files during a pull. Files are verified by SHA-256 before applying a downloaded snapshot.

If a publication response is lost, `state.json` retains its pending payload and operation identifier. Retry `workspace publish` with the same directory. Changes made locally after that attempt remain local changes after the original publication succeeds. A pending publication must be resolved before pulling. For a 409 conflict, retain that directory as your local copy, pull into a second fresh directory, reconcile the two deliberately, and publish the reconciled files from the fresh copy. There is no automatic force-overwrite or merge.

If the sandbox disappears, sign in again and run `workspace pull` in a fresh directory. Every acknowledged remote file can be recovered. Unpublished local edits and a local-only pending queue cannot survive destruction of that sandbox.

## Reference delegation policy

`kitebook workspace assist --goal "Explain the retry policy"` retrieves bounded shared knowledge. Add `--repository --project my-project --to mac` for read-only code inspection. Add `--edit --project my-project --to mac --operation-id my-stable-request-id` for authorized coding work; retries use that same identifier. `--task <id>` checks existing work instead of dispatching a duplicate. The reference flow reads `describe` before repository operations and leaves approvals to the existing server/runner policy. It does not observe other vendors' conversations or add an always-running model classifier.

## Protocol

`sync` supports `shared/`, `kb/` and `context/` roots, whose history is durable. `tasks/` and `repos/` have separate retention rules and are not durable file replicas. These operations are exposed through HTTP, MCP and the CLI's generic operation commands.

1. With no cursor, `sync {path}` captures a fixed commit watermark and pages a permission-filtered snapshot. Follow `cursor` while `more` is true, including empty filtered pages.
2. Collect the pages before applying them. For an incremental update, several versions of one path may appear; the last occurrence is the state to apply. Fetch live files with `sync_read {path,cursor:read_cursor}` at the fixed watermark. Apply deletions explicitly.
3. Persist the local files and final cursor before `sync_ack {replica,cursor}`. Replica identifiers belong to independent local copies, not a logical assistant identity. Acknowledgement records the folder, applied version and time; it does not certify current presence or continued existence of the cache.
4. A later `sync {cursor}` returns changes from the durable commit journal. Cursor positions include the path within a commit, so a batch wider than a page cannot skip files. Socket notifications and the pruned events feed are hints; their loss cannot hide a committed file from this recovery path.
5. Tokens are authenticated, workspace/identity/permission bound. On `reset_required`, obtain a fresh snapshot and reconcile previously cached files, including access removals. Import/restore changes the sync epoch. If the checkpoint's files are missing, bootstrap rather than trusting an old acknowledgement.
6. `sync_publish` requires a stable `operation_id` and an explicit `if_match` on every changed/deleted file. The receipt and file commit are atomic. Retrying the same identifier/payload returns the original result; a different payload using that identifier is refused. Stale writes fail as a whole. Existing task dispatch separately uses `idempotency_key` and task leases; file publication does not grant task ownership or bypass approvals.

Live clients can use existing events to trigger a sync or poll at a bounded interval. The reference CLI performs one synchronization per invocation; a host scheduler can invoke it while active. Hosted assistants differ in filesystem, credentials, background execution and wake support. An MCP connection cannot wake a stopped sandbox without vendor support, and it cannot observe conversations the vendor does not expose.

## Durability and backup

The server also needs persistent storage. For Docker, preserve the `/data` volume; on a self-host preserve the configured data directory and external blob backend. A disposable server filesystem is not durable just because its clients use this protocol.

The existing portable export includes file history and external blob bytes:

```sh
bun client/admin.ts export main > workspace-backup.json
# On the destination, create an empty workspace before importing:
bun client/admin.ts space restored
bun client/admin.ts import restored workspace-backup.json
```

Protect backups as private workspace data. Portable exports are subject to the existing HTTP/Durable Object message-size limits; for large workspaces, use a coordinated deployment-level backup of the database and external blob backend and test restoring both. Import rebuilds derived KB indexes, rotates the synchronization epoch and clears replica acknowledgements. Membership follows the destination's grants. In-flight tasks arrive failed because their old runner cannot continue them there. The portable dump is a migration/backup of workspace data, not a complete server identity/credential backup. An operator restoring raw database files must rotate/reset old client checkpoints or rebootstrap clients; a raw rollback outside the import API is not automatically detectable. Version history on the same disk is not an independent backup.

## Verification

`bun test client/workspace.test.ts` tests wide-commit pagination, concurrent snapshot writes, token isolation/tampering, independent replicas, cache loss, permission reconciliation, retry recovery and preservation of local edits. The smoke core runs `scripts/workspace-check.ts` against a real local server, including atomic receipts/conflicts, notification pruning, destroyed sandboxes and portable export/import of external blobs. These tests use synthetic agents and data. Live hosted-platform sign-in and wake behavior still require platform-specific validation.

The reference client refuses non-advancing or cyclic cursors, limits recovery to 1,000 pages / 100,000 entries, and bounds server-requested snapshot resets. Use a narrower path for a larger replica. An incomplete traversal never advances the saved checkpoint. If an acknowledgement response is lost, retrying from the saved checkpoint is safe; publication retries keep the same durable operation ID.
