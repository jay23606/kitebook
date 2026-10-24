// This machine as a Kitebook DEVICE (server: src/devices.ts; keys: client/keystore.ts).
//   runner start      ensureDevice(): make the device + presence keys once, enroll (op device_enroll). The first device an account ever sees
//                     (the owner's Mac on its first start after the upgrade, or a fresh install's runner) is owner device #1; later machines
//                     wait for `kitebook devices approve <id>` on an owner device (or the server shell). KITEBOOK_DEVICE=off skips it.
//   kitebook open     the runner signs a one-time token (60 s, single use, bound to this device and the CLI's nonce): <url>/open#t=…&n=…
//   kitebook confirm  presence for a browser: signs "confirm:<code>" with a presence key: the optional Touch ID / Windows Hello shortcut
//                     first when it is on, else (or when it fails in any way) the master password (client/password.ts)
//   kitebook devices  list | approve <id> | revoke <id> | rename <id> <name>   (approve asks for presence; revoke never does)
// State (not secret: ids and public keys) lives in ~/.kitebook/device-<runner>.json, so the CLI and the runner agree on the slot.
import "./brand.ts";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { homedir, hostname, platform, release } from "os";
import { deviceKey, presenceBackend, presencePub } from "./keystore.ts";
import { passwordPub, passwordSign, hasPassword } from "./password.ts";

// shortcut: whether the server knows this machine's Touch ID / Windows Hello key (false: don't use it, the server would refuse it)
export type DevState = { slot: string; url: string; account: string; id: string | null; state: string; pub: string; presence_pub: string | null; keystore: string; presence: string; gate: boolean; password?: boolean; shortcut?: boolean; locked?: boolean };
const dir = () => join(homedir(), ".kitebook");
export const slotOf = (name: string) => String(name).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 60) || "runner";
const stFile = (slot: string) => join(dir(), `device-${slot}.json`);
export const loadState = (name: string): DevState | null => { try { return JSON.parse(readFileSync(stFile(slotOf(name)), "utf8")); } catch { return null; } };
export const saveShortcut = (s: DevState, pub: string | null) => saveState({ ...s, presence_pub: pub, shortcut: !!pub, locked: !pub && !hasPassword(s.slot) });
const saveState = (s: DevState) => { mkdirSync(dir(), { recursive: true, mode: 0o700 }); writeFileSync(stFile(s.slot), JSON.stringify(s, null, 1), { mode: 0o600 }); };
const rnd = (n: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString("base64url");
const enc = (o: any) => Buffer.from(JSON.stringify(o)).toString("base64url");
export const sha256hex = async (s: string) => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))).toString("hex");
export const osLabel = () => ({ darwin: "macOS", win32: "Windows", linux: "Linux" } as any)[platform()] ?? platform();

// runner start: keys once, then enroll (the same keys again is a heartbeat). Never fatal: an older server without device_enroll just logs.
export async function ensureDevice(o: { name: string; url: string; account: string; call: (op: string, a?: any) => Promise<any>; log: (...x: any[]) => void }): Promise<DevState | null> {
  if (process.env.KITEBOOK_DEVICE === "off") return null;
  const slot = slotOf(o.name);
  try {
    const dk = await deviceKey(slot), pb = presenceBackend(); let ppub: string | null = presencePub(slot);
    // the shortcut is optional: made here only when KITEBOOK_PRESENCE names a backend on purpose; a device from before keeps its own
    if (!ppub && process.env.KITEBOOK_PRESENCE) { try { ppub = await pb.create(slot); } catch (e: any) { o.log("device: no Touch ID / Windows Hello shortcut (" + e.message + "); the master password still works"); } }
    const pwpub = passwordPub(slot); // keys go with a NEW device only; the server ignores them for one it already knows
    const r = await o.call("device_enroll", { name: `${hostname().replace(/\.local$/, "")}`.slice(0, 60), os: `${osLabel()} ${release()}`.slice(0, 40), pubkey: dk.pub, presence_key: ppub ?? undefined, password_key: pwpub ?? undefined });
    let v = r; // a password set before the runner ever started (kitebook password set, the setup link): registered now that the device exists
    if (pwpub && r.password === false && (r.locked || r.password_reset) && r.state !== "revoked") { try { v = await o.call("device_password", { password_key: pwpub, via: "install" }); } catch (e: any) { o.log("device: couldn't register this computer's master password: " + e.message); } }
    const s: DevState = { slot, url: o.url, account: o.account, id: r.id, state: r.state, pub: dk.pub, presence_pub: ppub, keystore: dk.store, presence: pb.name, gate: true,
      password: v.password ?? !!pwpub, shortcut: v.shortcut ?? !!ppub, locked: v.locked ?? (!pwpub && !ppub) };
    saveState(s);
    if (r.state !== "revoked") { if (s.locked) o.log("device: LOCKED: this computer has no master password yet, so nothing can be approved from it. A person sets it: kitebook password set (in a terminal) or kitebook password link (a one-time local link to hand them)");
      else if (!s.password) o.log("device: set a master password: kitebook password set (your Touch ID / Windows Hello shortcut keeps working meanwhile)"); }
    o.log(r.state === "active" ? `device: ${r.name} is ${r.via === "join" ? "an approved" : "the owner's"} device (${r.id}; key in ${dk.store}, presence by ${pb.name})`
      : r.state === "pending" ? `device: ${r.id} waits for approval: run kitebook devices approve ${r.id} on one of your devices (or bun client/admin.ts device approve ${r.id} on the server)`
      : `device: ${r.id} was revoked; kitebook open and approvals from this machine stop working`);
    return s;
  } catch (e: any) { o.log("device: not enrolled:", String(e?.message ?? e).slice(0, 200)); return null; }
}
// the runner, for `kitebook open`: t = <payload>.<sig> by the device key; nh = sha256(the CLI's nonce), so the link alone isn't enough
export async function openToken(s: DevState, nh: string): Promise<string> {
  if (!s.id || s.state !== "active") throw new Error("this machine isn't an active device of your Kitebook yet");
  if (!/^[0-9a-f]{64}$/.test(nh)) throw new Error("bad nonce hash");
  const raw = enc({ v: 1, k: "open", a: s.account, d: s.id, j: rnd(18), e: Date.now() + 60_000, n: nh }), dk = await deviceKey(s.slot);
  return `${raw}.${await dk.sign(`kitebook-open:v1.${raw}`)}`;
}
// an assertion for exactly one action, signed by `sign` (a presence key's signer); null when it didn't sign
export async function assertWith(s: DevState, action: string, sign: (msg: string) => Promise<string | null>): Promise<string | null> {
  if (!s.id) return null;
  const raw = enc({ v: 1, k: "presence", a: s.account, d: s.id, act: action, c: rnd(18), t: Date.now() }), sig = await sign(`kitebook-presence:v1.${raw}`);
  return sig ? `${raw}.${sig}` : null;
}
// a presence assertion for exactly one action; null when the human didn't confirm (or can't confirm here). The shortcut (Touch ID /
// Windows Hello / the Keychain dialog) first when it is on; on ANY failure (it threw, the helper is gone, the human cancelled) the master
// password, which the server accepts the same way (src/devices.ts: any active presence key of the device).
export async function presenceAssert(s: DevState, action: string, reason = action): Promise<string | null> {
  if (!s.id) return null;
  return assertWith(s, action, async msg => {
    let why = "";
    if (presencePub(s.slot) && s.shortcut !== false) {
      try { const sig = await presenceBackend().sign(s.slot, msg, reason); if (sig) return sig; why = "not confirmed"; } catch (e: any) { why = String(e?.message ?? e).slice(0, 120); }
      if (hasPassword(s.slot)) process.stderr.write(`(${presenceBackend().name} didn't confirm: ${why}. Using your master password instead.)\n`);
    }
    return hasPassword(s.slot) ? await passwordSign(s.slot, msg, reason) : null;
  });
}
// for CLIs that act for a runner by name (kitebook approve): its device state, if it enrolled
export const assertFor = async (runner: string, action: string, reason?: string) => { const s = loadState(runner); return s && s.state === "active" ? await presenceAssert(s, action, reason) : null; };

// ---- CLI ----
export const cfgOf = (argv: string[]) => { const f = argv.find(a => a.endsWith(".json")) ?? process.env.KITEBOOK_RUNNER_CONFIG ?? join(dir(), "runner.json");
  try { const c = JSON.parse(readFileSync(f, "utf8")); return { url: String(c.url).replace(/\/+$/, ""), token: String(c.token), name: String(c.name ?? "") }; } catch { return null; } };
async function api(c: { url: string; token: string }, op: string, a: any = {}) {
  const r = await fetch(`${c.url}/v1/${op}`, { method: "POST", headers: { authorization: `Bearer ${c.token}`, "content-type": "application/json" }, body: JSON.stringify(a), signal: AbortSignal.timeout(20_000) });
  const j: any = await r.json().catch(() => ({})); if (!j.ok) throw new Error(j.error ?? `HTTP ${r.status}`); return j.result;
}
// the device state that belongs to this runner.json (by the runner's peer name from whoami; else the only one there is)
export async function mine(c: { url: string; token: string; name?: string }): Promise<DevState | null> {
  let name = c.name; if (!name) { try { name = (await api(c, "whoami")).name; } catch {} }
  const s = name ? loadState(name) : null; if (s) return s;
  const all = existsSync(dir()) ? readdirSync(dir()).filter(f => /^device-.*\.json$/.test(f)) : []; return all.length === 1 ? JSON.parse(readFileSync(join(dir(), all[0]), "utf8")) : null;
}
const NOCFG = "This computer isn't connected to Kitebook yet (no runner.json). Install it first.";
export const NOPRES = "no master password or fingerprint / face unlock / Windows Hello given here; a computer without a master password is locked: kitebook password set";
// (an app's relay_update no longer waits for kitebook confirm: owner, 2026-10-22 22:00; it installs the latest by itself, client/settings-sync.ts)
export async function confirmCli(argv: string[]): Promise<number> {
  const code = argv.find(a => !a.startsWith("-") && !a.endsWith(".json"));
  const c = cfgOf(argv); if (!c) { console.error(NOCFG); return 1; }
  const s = await mine(c); if (!s?.id) { console.error("This computer isn't enrolled as a device yet: start its runner once (kitebook start)."); return 1; }
  if (!code) { const l = await api(c, "device_list").catch((e: any) => { console.error(e.message); return null; }); if (!l) return 1;
    if (!l.pending_confirmations?.length) { console.log("Nothing waits for your confirmation."); return 0; }
    for (const p of l.pending_confirmations) console.log(`[${p.code}] ${p.action}   (kitebook confirm ${p.code})`); return 0; }
  const up = code.toUpperCase(), a = await presenceAssert(s, `confirm:${up}`, `confirm ${up} in your browser`);
  if (!a) { console.error(`Not confirmed (${NOPRES}). Nothing was sent.`); return 1; }
  try { const r = await api(c, "presence_confirm", { code: up, presence: a }); console.log(`Confirmed: ${r.confirmed}. That browser can approve for the next 5 minutes.`); return 0; }
  catch (e: any) { console.error(`kitebook confirm: ${e.message}`); return 1; }
}
export async function devicesCli(argv: string[]): Promise<number> {
  const c = cfgOf(argv); if (!c) { console.error(NOCFG); return 1; }
  const [sub = "list", id, ...rest] = argv.filter(a => !a.endsWith(".json") && a !== "--json");
  try {
    if (sub === "list") { const l = await api(c, "device_list"); if (argv.includes("--json")) { console.log(JSON.stringify(l)); return 0; }
      for (const d of l.devices) console.log(`${d.id === l.me ? "*" : " "} ${d.id}  ${d.name}  ${d.os}  ${d.state}  ${d.locked ? "LOCKED (no master password)" : `password ${d.password ? "set" : "not set"}${d.shortcut ? " + shortcut" : ""}`}  last seen ${new Date(d.last_seen).toLocaleString()}  browsers ${d.sessions}`); return 0; }
    if (sub === "revoke") { const r = await api(c, "device_revoke", { id }); console.log(`Revoked ${r.name} (${r.id}): its browser sessions and runner are signed out.`); return 0; }
    if (sub === "rename") { const r = await api(c, "device_rename", { id, name: rest.join(" ") }); console.log(`Renamed ${r.id} to ${r.name}.`); return 0; }
    if (sub === "approve") { const s = await mine(c); if (!s) { console.error("This computer isn't an enrolled device."); return 1; }
      const a = await presenceAssert(s, `device_approve:${id}`, `approve device ${id}`); if (!a) { console.error(`Not confirmed (${NOPRES}). Nothing was approved.`); return 1; }
      const r = await api(c, "device_approve", { id, presence: a }); console.log(`Approved ${r.name} (${r.id}).`); return 0; }
    // another device forgot its master password: from here (a trusted device, with your presence) it may set a new one for 15 minutes
    if (sub === "reset-password") { const s = await mine(c); if (!s?.id) { console.error("This computer isn't an enrolled device."); return 1; }
      const a = await presenceAssert(s, `device_password_reset:${id}`, `reset the master password of device ${id}`); if (!a) { console.error(`Not confirmed (${NOPRES}). Nothing was reset.`); return 1; }
      const r = await api(c, "device_password_reset", { id, presence: a });
      console.log(`Reset: ${r.name} (${r.id}) may set a new master password for the next 15 minutes: on that computer run kitebook password set.`); return 0; }
    console.error("kitebook devices [list|approve <id>|revoke <id>|rename <id> <name>|reset-password <id>]"); return 2;
  } catch (e: any) { console.error(`kitebook devices: ${e.message}`); return 1; }
}

// ---- the one-step pairing page (POST /connect -> /device?user_code=..., src/oauth.ts pairBody) ----
// The page, opened on this Mac, asks here (127.0.0.1:47615, KITEBOOK_PRESENCE_PORT moves it) for a presence assertion: the master password
// typed into the page unlocks this device's password presence key, which signs exactly "device_grant:<code>" (or the Touch ID / Windows
// Hello shortcut signs it). The password never leaves this machine and the server only sees the signature. Only pages of this Kitebook
// (its URL, the tunnel's public address, KITEBOOK_PAGE_ORIGINS) may ask; wrong passwords count toward the same growing waits as the terminal.
export const helperPort = () => Number(process.env.KITEBOOK_PRESENCE_PORT) || 47615;
export const PAIR_ACTION = /^device_grant:[A-Z]{4}-[A-Z]{4}$/;
export async function helperAnswer(s: DevState, b: any, sign: { password: (pw: string, msg: string) => Promise<string>; shortcut: (msg: string) => Promise<string | null> }): Promise<{ ok: boolean; presence?: string; error?: string }> {
  const action = String(b?.action ?? ""); if (!PAIR_ACTION.test(action)) return { ok: false, error: "this helper only confirms a pairing code (device_grant:XXXX-XXXX)" };
  if (s.state !== "active" || !s.id) return { ok: false, error: "this Mac isn't an approved Kitebook device yet" };
  try {
    const p = b.shortcut === true ? await assertWith(s, action, m => sign.shortcut(m)) : typeof b.password === "string" && b.password ? await assertWith(s, action, m => sign.password(b.password, m)) : null;
    return p ? { ok: true, presence: p } : { ok: false, error: b.shortcut === true ? "Touch ID / Windows Hello didn't confirm (or isn't set up here): type your master password instead" : "type your Kitebook master password" };
  } catch (e: any) { return { ok: false, error: String(e?.message ?? e).slice(0, 200) }; }
}
export function presenceHelper(s: () => DevState | null, origins: () => string[], log: (...x: any[]) => void) {
  const cors = (o: string) => ({ "access-control-allow-origin": o, "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type", "access-control-allow-private-network": "true", vary: "origin", "cache-control": "no-store" });
  try {
    return Bun.serve({ hostname: "127.0.0.1", port: helperPort(), async fetch(req) {
      const o = req.headers.get("origin") ?? "", ok = !!o && origins().includes(o);
      if (new URL(req.url).pathname !== "/presence") return new Response("not found", { status: 404 });
      if (!ok) return new Response(JSON.stringify({ ok: false, error: "not a page of this Kitebook" }), { status: 403, headers: { "content-type": "application/json" } });
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(o) });
      if (req.method !== "POST") return new Response(null, { status: 405, headers: cors(o) });
      const st = s(); if (!st) return Response.json({ ok: false, error: "this Mac isn't an approved Kitebook device yet" }, { headers: cors(o) });
      const { unlock } = await import("./password.ts"), { signWith } = await import("./keystore.ts");
      const r = await helperAnswer(st, await req.json().catch(() => ({})), { password: async (pw, m) => await signWith(unlock(st.slot, pw), m),
        shortcut: async m => presencePub(st.slot) ? await presenceBackend().sign(st.slot, m, "connect an app to Kitebook") : null });
      log(`pairing page: ${r.ok ? "confirmed" : "not confirmed"}`); return Response.json(r, { headers: cors(o) });
    } });
  } catch (e: any) { log(`pairing helper not started (port ${helperPort()}: ${e?.message ?? e}); pairing links still work with kitebook approve <code>`); return null; }
}
// `kitebook approve ABCD-EFGH` for a pairing code: this device's presence (master password / shortcut) approves it with the default access
export async function pairApprove(cfg: { url: string; token: string; name?: string }, code: string): Promise<number> {
  const s = await mine(cfg); if (!s || s.state !== "active") { console.error("This computer isn't an approved Kitebook device, so it can't approve a pairing code."); return 1; }
  const c = code.toUpperCase(), p = await presenceAssert(s, `device_grant:${c}`, `connect the app with code ${c}`); if (!p) { console.error("Not confirmed (your master password is needed); nothing was approved."); return 1; }
  const r = await fetch(`${cfg.url}/device`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "approve", user_code: c, presence: p }) });
  const j: any = await r.json().catch(() => ({})); if (!j.ok) { console.error(`Not connected: ${j.error_description ?? j.error ?? r.status}`); return 1; }
  console.log(j.passkey ? `Added: ${j.name}. It can approve with its passkey now (remove it any time in Settings -> Devices).` : `Connected: ${j.name}. ${j.granted ?? ""} It finishes connecting on its own.`); return 0;
}
// kitebook app add <name> [--access tasks|read|folder] [--days 1|7|30] [--json]: Settings' Add an app from the Mac. Prints the key ONCE and
// the prompt to paste into the app (which asks for the key through its own secret prompt, so the key never sits in a chat).
export async function appAddCli(argv: string[]): Promise<number> {
  const c = cfgOf(argv), opt = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; }, name = argv.find((a, i) => !a.startsWith("-") && !a.endsWith(".json") && !["--access", "--days"].includes(argv[i - 1] ?? ""));
  if (!name) { console.error("kitebook app add <name> [--access tasks|read|folder] [--days 1|7|30]   (tasks = read everything, save to shared memory shared/ + kb/, send tasks: the default)"); return 2; }
  if (!c) { console.error("This computer isn't connected to Kitebook yet (no runner.json)."); return 1; }
  const s = await mine(c), p = s?.state === "active" ? await presenceAssert(s, `app_add:${name}`, `add the app ${name}`) : null;
  if (s?.state === "active" && !p) { console.error("Not confirmed (your master password is needed to add an app); nothing was added."); return 1; }
  let r: any; try { r = await api(c, "app_add", { name, access: opt("--access") ?? "tasks", days: opt("--days") ? Number(opt("--days")) : null, ...(p ? { presence: p } : {}) }); } catch (e: any) { console.error(`Not added: ${e.message}`); return 1; }
  if (argv.includes("--json")) { console.log(JSON.stringify(r)); return 0; }
  console.log(`Added ${r.peer} (${r.access}${r.expires ? `, until ${new Date(r.expires).toLocaleDateString()}` : ""}). Remove it any time in Settings -> Connected apps.\n\nIts key (shown only now; paste it only into the app's secure credential prompt):\n  ${r.key}\n\nThe prompt to give the app:\n  ${r.prompt}`);
  return 0;
}
