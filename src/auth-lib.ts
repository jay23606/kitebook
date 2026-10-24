// The Better Auth stack (and Kysely, passkeys/WebAuthn, CIMD), loaded only when an account's Better Auth is first built (auth.ts ba()).
// Kept behind a dynamic import so a cold isolate that never touches sign-in (Space objects, the front door's /v1 and /mcp routing,
// /health, pages) doesn't parse/evaluate it: the bundle stays one file (vite codeSplitting:false), the import just runs it on first use.
export { Kysely } from "kysely";
export { DurableObjectSqliteDialect } from "kysely-durable-objects";
export { betterAuth } from "better-auth/minimal";
export { jwt } from "better-auth/plugins/jwt";
export { createAuthEndpoint, APIError } from "better-auth/api";
export { setSessionCookie } from "better-auth/cookies";
export { getMigrations } from "better-auth/db/migration";
export { kyselyAdapter } from "@better-auth/kysely-adapter";
export { passkey } from "@better-auth/passkey";
export { mcp } from "@better-auth/mcp";
export { cimd } from "@better-auth/cimd";
export { createLocalJWKSet, jwtVerify } from "jose";
