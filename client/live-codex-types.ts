// The slice of the Codex app-server protocol Kitebook uses (client/live-codex.ts), copied from the STABLE bindings that the installed binary
// generates: `codex app-server generate-ts --out DIR` (no --experimental), codex-cli 0.163.0, 2026-10-22. Only the fields Kitebook reads
// or sends are kept; the rest of each type is left open ([k: string]: unknown) so a newer Codex adding fields still type-checks.
// Wire format (checked against the real 0.163.0 binary): JSON-RPC 2.0 without the "jsonrpc" field, one JSON object per line on stdio.
// Docs: https://developers.openai.com/codex/app-server. To refresh: regenerate, diff the types below, keep to the stable surface.
type Open = { [k: string]: unknown };

export type ClientInfo = { name: string; title: string | null; version: string };
export type InitializeParams = { clientInfo: ClientInfo; capabilities: { experimentalApi: boolean; requestAttestation: boolean; optOutNotificationMethods?: string[] | null } | null };
export type InitializeResponse = { userAgent: string; codexHome: string; platformFamily: string; platformOs: string };

export type AskForApproval = "untrusted" | "on-request" | "never";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type NetworkAccess = "restricted" | "enabled";
// externalSandbox: "if you already sandbox the server process and want Codex to skip its own sandbox enforcement" (the app-server docs)
export type SandboxPolicy = { type: "dangerFullAccess" } | { type: "readOnly"; networkAccess: boolean } | { type: "externalSandbox"; networkAccess: NetworkAccess }
  | { type: "workspaceWrite"; writableRoots: string[]; networkAccess: boolean; excludeTmpdirEnvVar: boolean; excludeSlashTmp: boolean };

export type Thread = Open & { id: string; sessionId: string; forkedFromId: string | null; preview: string; name: string | null; cwd: string; createdAt: number; updatedAt: number; turns?: Turn[] };
export type ThreadStartParams = { model?: string | null; cwd?: string | null; approvalPolicy?: AskForApproval | null; sandbox?: SandboxMode | null; serviceName?: string | null; ephemeral?: boolean | null; developerInstructions?: string | null };
export type ThreadResumeParams = { threadId: string; model?: string | null; cwd?: string | null; approvalPolicy?: AskForApproval | null; sandbox?: SandboxMode | null; excludeTurns?: boolean };
// fork copies stored history into a NEW thread; the source keeps its writer (owner sessions are never written to)
export type ThreadForkParams = { threadId: string; lastTurnId?: string | null; model?: string | null; cwd?: string | null; approvalPolicy?: AskForApproval | null; sandbox?: SandboxMode | null; ephemeral?: boolean; excludeTurns?: boolean };
export type ThreadResponse = Open & { thread: Thread; model: string; cwd: string; sandbox: SandboxPolicy };
export type ThreadListParams = { cursor?: string | null; limit?: number | null; sortKey?: "created_at" | "updated_at" | null; cwd?: string | string[] | null; archived?: boolean | null; searchTerm?: string | null };
export type ThreadListResponse = { data: Thread[]; nextCursor: string | null };

export type UserInput = { type: "text"; text: string; text_elements: unknown[] };
export type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";
export type TurnError = Open & { message: string; additionalDetails: string | null };
export type Turn = Open & { id: string; status: TurnStatus; error: TurnError | null };
export type TurnStartParams = { threadId: string; input: UserInput[]; model?: string | null; approvalPolicy?: AskForApproval | null; sandboxPolicy?: SandboxPolicy | null; cwd?: string | null };
export type TurnSteerParams = { threadId: string; input: UserInput[]; expectedTurnId: string }; // fails unless expectedTurnId is the active turn
export type TurnInterruptParams = { threadId: string; turnId: string };

export type FileUpdateChange = { path: string; kind: unknown; diff: string };
export type ThreadItem = Open & ({ type: "agentMessage"; id: string; text: string; phase?: string | null } | { type: "commandExecution"; id: string; command: string; cwd: string; exitCode: number | null; status: string }
  | { type: "fileChange"; id: string; changes: FileUpdateChange[]; status: string } | { type: "mcpToolCall"; id: string; server: string; tool: string; status: string; error: unknown }
  | { type: "userMessage" | "reasoning" | "plan" | "webSearch" | string; id: string });

// server -> client notifications Kitebook reads (all carry threadId)
export type Notification =
  | { method: "thread/started"; params: { thread: Thread } }
  | { method: "turn/started" | "turn/completed"; params: { threadId: string; turn: Turn } }
  | { method: "item/started" | "item/completed"; params: { threadId: string; turnId: string; item: ThreadItem } }
  | { method: "item/agentMessage/delta"; params: { threadId: string; turnId: string; itemId: string; delta: string } }
  | { method: "error"; params: { threadId: string; turnId: string; willRetry: boolean; error: TurnError } }
  | { method: "serverRequest/resolved"; params: { threadId: string; requestId: number | string } };

// server -> client requests (approvals). Decisions: command accept|acceptForSession|decline|cancel; file change the same.
export type CommandExecutionRequestApprovalParams = Open & { threadId: string; turnId: string; itemId: string; command?: string | null; cwd?: string | null; reason?: string | null };
export type FileChangeRequestApprovalParams = Open & { threadId: string; turnId: string; itemId: string; reason?: string | null; grantRoot?: string | null };
export type PermissionsRequestApprovalParams = Open & { threadId: string; turnId: string; itemId: string; cwd: string; reason: string | null; permissions: { network: unknown; fileSystem: unknown } };
export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";
