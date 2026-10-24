// The product's names in one place. Relay was renamed Kitebook (2026-10): the command is `kitebook` (CLI= in scripts/get.sh and $CLI in
// scripts/get.ps1 write its wrapper), and everything a pre-rename install left behind keeps working through an update:
//   env      KITEBOOK_* is the name; RELAY_* is still read (aliasEnv below runs when any client module loads: the first import of every
//            entry point, and the Worker's start.ts; a KITEBOOK_ value wins over its RELAY_ twin)
//   folders  ~/.relay-runner -> ~/.kitebook, ~/.relay-server -> ~/.kitebook-server, ~/.relay-app -> ~/.kitebook-app, ~/.relay-node ->
//            ~/.kitebook-node, ~/.relay (KB cache, outbox, kb-inbox) -> ~/.kitebook-kb, ~/.config/relay -> ~/.config/kitebook and the
//            log folder: moved once, the old name left as a link to the new one (client/rebrand.ts)
//   services dev.relay.<x> (launchd), relay-<x> (systemd --user, Kitebook's supervisor / Windows logon task) -> dev.kitebook.<x> /
//            kitebook-<x>, moved by client/rebrand.ts; until then client/service.ts manages whichever of the two is installed
//   command  `relay` stays as a one-line shim that says so and runs `kitebook`
// Wire names stay as they were, so old and new runners, servers and agents keep talking: x-relay-* headers, signed-message domains
// (relay-policy:v1, relay-owner-cmd:v1, relay-dispatch:v1, ...), the relay-<acct> session cookie, the relay-cli OAuth client, the
// relay_update tool, agent markers ([relay-question: ...], .relay-learnings.md), Durable Object keys, and the GitHub repo (now um1b/kitebook, formerly um1b/relay).
export const CLI = "kitebook", LEGACY_CLI = "relay", NAME = "Kitebook";
export const TAGLINE = "A shared knowledge base for your AI assistants and coding agents. Hand off tasks from any assistant to the agents on your own machine and get back a branch, diff and tests.";
export const LABEL = { server: "dev.kitebook.server", runner: "dev.kitebook.runner", tunnel: "dev.kitebook.tunnel", ngrok: "dev.kitebook.ngrok" } as const;
export const LEGACY_LABEL = { server: "dev.relay.server", runner: "dev.relay.runner", tunnel: "dev.relay.tunnel", ngrok: "dev.relay.ngrok" } as const;
export const UNIT = { server: "kitebook-server", runner: "kitebook-runner", tunnel: "kitebook-tunnel" } as const;
export const LEGACY_UNIT = { server: "relay-server", runner: "relay-runner", tunnel: "relay-tunnel" } as const;
// the one-line note the `relay` shim prints (stderr, so scripts reading JSON from stdout are unaffected)
export const DEPRECATION = `note: the relay command is now ${CLI} (Relay was renamed Kitebook); relay still works for now, but use ${CLI}`;

// RELAY_X -> KITEBOOK_X for every RELAY_ variable that has no KITEBOOK_ twin. Child processes inherit both names.
export function aliasEnv(env: Record<string, string | undefined> | undefined = (globalThis as any).process?.env) {
  if (!env) return env;
  for (const k of Object.keys(env)) if (k.startsWith("RELAY_")) { const n = "KITEBOOK_" + k.slice(6); if (env[n] === undefined) env[n] = env[k]; }
  return env;
}
aliasEnv();

export const HELP = `${CLI}: Kitebook on this Mac

  ${CLI} status                 is everything up? server, runner, public access, version
  ${CLI} open                   open Kitebook in your browser, signed in   (${CLI} settings: straight to Settings)
  ${CLI} update                 update now (it also updates by itself, and Settings -> Updates has Update now)   (${CLI} pin <version|->: approve one exact version for the next update)
  ${CLI} agents                 connect the coding agents on this Mac (Pi, Codex, Claude Code, ...)   (--list: just show them)
  ${CLI} tunnel on|off          public access for Claude.ai and ChatGPT (also Settings -> Connection)   (${CLI} tunnel: its address)
  ${CLI} approve                tasks waiting for your OK on this Mac
  ${CLI} password               your master password: set | change | link (a one-time link when there's no terminal) | shortcut on|off (Touch ID)
  ${CLI} join <url>             add this computer (laptop, cloud VM) by code; approve with ${CLI} approve <code> on one of your devices   (${CLI} login <url>: claim a server you host)
  ${CLI} logs [server|runner|tunnel] [-f]      ${CLI} restart | stop | start [server|runner|tunnel|all]
  ${CLI} logs --errors          recent errors from the server and this Mac, secrets hidden (with Experimental on, your apps can read them too)
  ${CLI} doctor                 check everything; one fix per problem
  ${CLI} uninstall              remove Kitebook from this Mac (your data stays; --all removes it too)

For scripts and agents: ${CLI} ops lists every workspace command (JSON in, JSON out).`;
