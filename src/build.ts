// Which code this server runs: version, commit and channel (main | dev | local) of the checkout it was built from (vite.config.ts bakes it
// in; client/channel.ts computes it). Only for signed-in callers: describe.server and Settings -> Updates; /health stays {ok:true}; its local-only build/MCP headers are cheap update hints (only /health?build=1 on the local listener adds the commit, for the Mac's own update check).
export const SERVER_BUILD: { version: string; commit: string | null; channel: string; built_at: string | null } =
  typeof __KITEBOOK_BUILD__ !== "undefined" && __KITEBOOK_BUILD__ ? __KITEBOOK_BUILD__ : { version: "unknown", commit: null, channel: "unknown", built_at: null };
