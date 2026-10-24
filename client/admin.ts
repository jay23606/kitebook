#!/usr/bin/env bun
// Admin CLI over HTTPS. Env: KITEBOOK_URL, KITEBOOK_ADMIN_TOKEN (the Worker's ADMIN_TOKEN secret).
//   bun admin.ts space <id> [name]
//   bun admin.ts peer <name> <assistant|coding_agent|runner|human> [webhook-url]   -> prints a token once
//   bun admin.ts invite <space> <kind> <verbs,comma> <glob> [glob...]   -> single-use URL an agent redeems itself (24h)
//   bun admin.ts grant <peer> <space> <verbs,comma> <glob> [glob...]
//   bun admin.ts revoke <peer> | rotate <peer> | list
//   bun admin.ts grants                   -> OAuth approvals (token families: id, peer, client, space, verbs)
//   bun admin.ts revoke_grant <id>        -> end one OAuth approval (its tokens + its event subscriptions); revoke <peer> ends all of a peer's
//   bun admin.ts status                   -> what's connected and online, tasks in flight, what needs you, recent results (same as the status card on /start)
//   bun admin.ts usage                    -> your account's spaces / peers / storage against its quotas, and its daily request / admin counters
//   bun admin.ts audit [limit] [before]   -> your account's audit trail, newest first: who changed what (no secrets); before = a seq to page back
//   bun admin.ts users                    -> the people in your account (today: its owner)
//   bun admin.ts quota <account> [spaces=N] [peers=N] [storage_mb=N]   -> operator only: one account's quotas (0 = unlimited, key=- = default)
//   bun admin.ts export <space> > space.json     (one-file backup / move to another host)
//   bun admin.ts import <space> space.json
//   bun admin.ts device list | approve <id> | revoke <id> | rename <id> <name> | reset-password [<id>]   -> this Kitebook's machines (approve: the server
//                                      shell's way, also after every device is lost; reset-password: a forgotten master password, 15 minutes to set a new one)
//   bun admin.ts open [--print]          -> sign a browser in to /start (a single-use 5-minute link; the operator's first sign-in)
//   bun admin.ts signup <account>        -> new account on a shared Kitebook (with space main); prints its recovery code once and the /start link (operator key, or OPEN_SIGNUP=1)
//   bun admin.ts rotate_admin            -> a new recovery code for your account (the old one stops working)
//   bun admin.ts stuck <space> [minutes]  -> show/set when a claimed/running task with no progress reads "stuck?" (default 10, STUCK_MIN env; 0 = off)
//   bun admin.ts pause <space> [peer] [reason...]   -> kill switch: refuse new tasks (whole space, or from one dispatcher), cancel active ones, runners kill agents
//   bun admin.ts retention <space> [days] [events_max]   -> show/set how long finished tasks + events are kept (default 30, RETENTION_DAYS env; 0 = forever)
//                                       and the event-log cap (default 100000 events, EVENTS_MAX env; 0 = no cap; events of active tasks always stay)
//                                       [repos_history] [gc_grace_sec]: earlier versions kept per repos/ file (default 10, REPOS_HISTORY; 0 = current tree only)
//                                       and how long an unreferenced blob waits before blob GC deletes it (default 86400, BLOB_GC_GRACE_SEC); "-" skips a field
//   bun admin.ts gc <space> [grace_sec]   -> blob GC now: mark unreferenced blobs, delete the ones past the grace (0 = now); shows bytes freed (also in usage)
//   bun admin.ts gc_store [delete] [grace_sec]  -> operator only: audit the shared blob store for objects no space references; delete removes them
//   bun admin.ts ratelimit <space> [per_min] [peer]  -> show/set requests per minute per token (default 600, RATE_PER_MIN env; 0 = no limit)
//   bun admin.ts prune <space> [older_than_sec]  -> run retention now (finished tasks + their files/events, old events, orphan blobs)
//   bun admin.ts title <display name...>             -> your account's MCP connector title (no name = back to the kitebook default, "Kitebook")
//   bun admin.ts resume <space> [peer]              -> lift it (no peer = lift everything in the space)
//   bun admin.ts policy [space]                     -> standing permissions: the signed policy, each app with what it can do, runners' pinned owner keys, audit list
//   bun admin.ts policy_set <space> <app> <envelope.json> [access.json] [undo_of]   -> a new owner-signed policy (signed in a browser or by your own P-256 key)
//   bun admin.ts owner_key <p256:...> [label] | owner_key remove <fingerprint>   -> register / remove an owner key (/start does this for each browser)
//   bun admin.ts app_key <space> <app>              -> the relay-held signing key for an app that can't sign its own tasks (public half)
// KITEBOOK_ADMIN_TOKEN is either the operator's ADMIN_TOKEN (root account) or an account's recovery code (ak.<account>....).
// Same default as cli.ts: `cf dev` (vite) listens on 5173. A hosted Kitebook always needs KITEBOOK_URL.
// On the server's own machine (a local URL) with KITEBOOK_ADMIN_TOKEN unset (not just empty), it reads ADMIN_TOKEN from ./.dev.vars itself, so nobody opens the file to copy it.
import "./brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
const URL_ = (process.env.KITEBOOK_URL ?? "http://localhost:5173").replace(/\/+$/, ""), T = process.env.KITEBOOK_ADMIN_TOKEN ?? (/^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(URL_) ? (() => { try { return (require("fs").readFileSync(".dev.vars", "utf8").match(/^ADMIN_TOKEN=(.+)$/m) ?? [])[1]?.trim(); } catch { return undefined; } })() : undefined);
if (process.argv[2] === "open") { // the operator's first sign-in on this machine: a single-use 5-minute link to /start, opened in the browser
  const r: any = await (await fetch(`${URL_}/admin/login_link`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${T}` }, body: "{}" })).json().catch(() => ({}));
  if (!r.ok) { console.error(`couldn't make a sign-in link: ${r.error ?? "no answer"}`); process.exit(1); }
  const link = `${URL_}/start#login=${r.result.token}`, op = (await import("./platform.ts")).opener(link); // open / xdg-open / the Windows URL handler
  if (op && !process.argv.includes("--print") && Bun.spawnSync(op).exitCode === 0) console.log("Opened Kitebook in your browser, signed in."); else console.log(`Open this within 5 minutes (it works once):\n${link}`);
  process.exit(0);
}
const post = async (path: string, body: any, auth?: string) => {
  try { return await fetch(`${URL_}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body) }); }
  catch (e: any) { console.error(`can't reach ${URL_} (${e?.code ?? e?.message ?? e}).${process.env.KITEBOOK_URL ? "" : " KITEBOOK_URL isn't set, so this is the local `cf dev` default; export KITEBOOK_URL=https://<your Kitebook>"}`); process.exit(1); }
};
const [cmd, ...a] = process.argv.slice(2);
if (cmd === "signup") {
  const r = await post("/signup", { account: a[0] }, T);
  const j: any = await r.json(); if (!j.ok) { console.error(j.error); process.exit(1); }
  console.error(`recovery code for account ${a[0]} (also its KITEBOOK_ADMIN_TOKEN), shown once:`); console.log(j.result.admin_key);
  console.error(`workspace ${j.result.space ?? "main"} is ready. Next: open ${j.result.start ?? URL_ + "/start"} and sign in with that key to connect your agents.`); process.exit(0);
}
if (!T) { console.error("set KITEBOOK_ADMIN_TOKEN"); process.exit(2); }
// devices from the server shell (src/devices.ts): list | approve <id> | revoke <id> | rename <id> <name>. Approve here is the server
// shell's own way (no presence key needed: shell access to the server is the owner), also the way back in after every device is gone.
if (cmd === "device" || cmd === "devices") {
  const sub = cmd === "devices" ? "list" : a[0] ?? "list", m: any = { list: ["devices", {}], approve: ["device_approve", { id: a[1] }], revoke: ["device_revoke", { id: a[1] }], rename: ["device_rename", { id: a[1], name: a.slice(2).join(" ") }], "reset-password": ["device_password_reset", { id: a[1] }] };
  if (!m[sub]) { console.error("usage: device list | approve <id> | revoke <id> | rename <id> <name> | reset-password [<id>]"); process.exit(2); }
  const j: any = await (await post(`/admin/${m[sub][0]}`, m[sub][1], T)).json(); if (!j.ok) { console.error(j.error); process.exit(1); }
  console.log(JSON.stringify(j.result, null, 1)); process.exit(0);
}
const body: Record<string, any> = {
  space: { id: a[0], name: a[1] }, peer: { name: a[0], kind: a[1], webhook: a[2] },
  grant: { peer: a[0], space: a[1], verbs: a[2]?.split(","), paths: a.slice(3) },
  invite: { space: a[0], kind: a[1], verbs: a[2]?.split(","), paths: a.slice(3) },
  retention: { space: a[0], days: a[1] === "-" ? undefined : a[1], events_max: a[2], repos_history: a[3], gc_grace_sec: a[4] },
  gc: { space: a[0], grace_sec: a[1] }, gc_store: { delete: a[0] === "delete", grace_sec: a[0] === "delete" ? a[1] : a[0] }, ratelimit: { space: a[0], per_min: a[1] === "-" ? undefined : a[1], peer: a[2] }, prune: { space: a[0], older_than_sec: a[1] },
  pause: { space: a[0], peer: a[1] === "-" ? undefined : a[1], reason: a.slice(2).join(" ") || undefined }, resume: { space: a[0], peer: a[1] }, stuck: { space: a[0], minutes: a[1] },
  policy: a[0] ? { space: a[0] } : {}, app_key: { space: a[0], app: a[1] }, owner_key: a[0] === "remove" ? { remove: a[1] } : { key: a[0], label: a.slice(1).join(" ") || undefined },
  policy_set: cmd === "policy_set" ? { space: a[0], app: a[1], envelope: JSON.parse(await Bun.file(a[2]).text()), access: a[3] && a[3] !== "-" ? JSON.parse(await Bun.file(a[3]).text()) : null, undo_of: a[4] ?? null } : {},
  title: { title: a.join(" ") }, ingress: a[0] ? { lockdown: a[0] } : {}, grants: {}, status: {}, revoke_grant: { id: a[0] }, usage: {}, audit: { limit: a[0], before: a[1] }, users: {},
  quota: { account: a[0], ...Object.fromEntries(a.slice(1).map(kv => kv.split("=")).map(([k, v]) => [k, v === "-" ? null : Number(v)])) }, revoke: { peer: a[0] }, rotate: { peer: a[0] }, rotate_admin: {}, list: {}, export: { space: a[0] },
  import: cmd === "import" ? { space: a[0], dump: JSON.parse(await Bun.file(a[1]).text()) } : {},
};
if (!(cmd in body)) { console.log("usage: ingress [on|off|auto] | space | peer | invite | grant | revoke | rotate | list | grants | revoke_grant | status | usage | audit | users | quota | export | import | retention | ratelimit | prune | gc | gc_store | pause | resume | stuck | title | policy | policy_set | owner_key | app_key"); process.exit(2); }
const r = await post(`/admin/${cmd}`, body[cmd], T);
const j: any = await r.json();
if (!j.ok) { console.error(j.error); process.exit(1); }
if (cmd === "invite") console.log(URL_ + j.result.path);
else if (cmd === "rotate_admin") { console.error("new recovery code, shown once:"); console.log(j.result.admin_key); }
else if (cmd === "peer" || cmd === "rotate") { console.error(`token for ${a[0]}, shown once:`); console.log(j.result.token); }
else console.log(JSON.stringify(j.result, null, 1));
