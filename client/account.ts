// The account model, shared by src/ and the Mac (client/ can't import src/: the install takes client/*.ts only). Account = the tenant
// every DO, row and credential belongs to; user = a person in it (today only the owner, whose id is the device rows' tenant key).
// Root's legacy names (DO "root"/"<space>", no /u/<acct>) are decided here only, never by a "root" literal elsewhere.
export const ROOT_ACCOUNT = "root";
export const ACCT_SRC = "[a-z0-9][a-z0-9-]{1,30}";
export const isRoot = (acct: string | null | undefined) => (acct || ROOT_ACCOUNT) === ROOT_ACCOUNT;
export const normAcct = (acct: string | null | undefined) => acct || ROOT_ACCOUNT;
export const dirName = (acct: string | null | undefined) => isRoot(acct) ? ROOT_ACCOUNT : `acct:${acct}`;
export const spaceName = (acct: string | null | undefined, space: string) => isRoot(acct) ? space : `${acct}:${space}`;
export const acctPath = (acct: string | null | undefined, p: string) => isRoot(acct) ? p : `/u/${acct}${p}`;
export type Role = "owner" | "admin" | "member" | "viewer";
export const ROLES: Role[] = ["owner", "admin", "member", "viewer"];
export const OWNER_USER = "owner";
export type User = { id: string; account: string; role: Role; created: string | null };
export type Account = { id: string; users: User[] };
