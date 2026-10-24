// Adding this computer to a Kitebook by code, never a pasted token (server: src/join.ts, src/claim.ts; keys: client/keystore.ts).
//   kitebook join <server> [--name n] [--account a]    a laptop, a cloud VM, a CI box: makes this machine's device + presence keys (keychain or
//                                                       a 0600 file), prints a code, polls; you approve the code on one of your devices
//                                                       (kitebook approve <code>, or Settings -> Devices). Then it is a runner of that Kitebook.
//   kitebook login <server> [--secret]                  claim a remote server that starts unclaimed: this computer becomes its OWNER device once
//                                                       you approve the same code on the server's shell (kitebook owner approve <code>), or at
//                                                       once with the single-use KITEBOOK_OWNER_CLAIM secret (--secret; read from that env var)
//   kitebook approve <code> [yes|no] [--yes]            on one of your devices: shows the machine (name, OS, IP, rough place) and a warning,
//                                                       then asks for your presence (Touch ID / Windows Hello / your password) before approving
//   kitebook owner [status|pending|approve <code>|deny <code>|reset]   on the SERVER's shell (its ADMIN_TOKEN): the claim
// Both new-machine commands also take init's flags (--out, --force, --roots, --approve, --no-install, --release-key) and --new-key.
import "./brand.ts";
import { readFileSync, existsSync, rmSync } from "fs";
import { join, resolve } from "path";
import { homedir, hostname, release } from "os";
import { deviceKey, deviceStore, presenceBackend, presencePub, keyDir } from "./keystore.ts";

const slotOf = (name: string) => String(name).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 60) || "runner"; // = client/device.ts: the runner finds these keys by its name
const osName = () => (({ darwin: "macOS", win32: "Windows", linux: "Linux" } as any)[process.platform] ?? process.platform) + " " + release();
export const JOIN_CODE_RE = /^[BCDFGHJKMNPQRSTVWXZ]{4}-?[BCDFGHJKMNPQRSTVWXZ]{4}$/i;
const norm = (c: string) => { const s = c.toUpperCase().replace(/[^A-Z]/g, ""); return `${s.slice(0, 4)}-${s.slice(4)}`; };
function flags(argv: string[], bools: string[]) {
  const f: Record<string, string> = {}, pos: string[] = [];
  for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith("--")) { const [k, v] = a.slice(2).split("="); f[k] = v ?? (bools.includes(k) || argv[i + 1] === undefined || argv[i + 1].startsWith("--") ? "1" : argv[++i]); } else pos.push(a); }
  return { f, pos };
}
const post = async (url: string, body: any, auth?: string) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  const j: any = await r.json().catch(() => null); if (!j) throw new Error(`${new URL(url).origin} answered HTTP ${r.status}, not like a Kitebook server. Check the address.`); return j;
};
const mins = (s: number) => s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`;
const INIT_BOOLS = ["force", "phone", "no-install", "verbose", "new-key", "yes", "json", "no-password"];

// ---- the new machine: kitebook join / kitebook login <server> ----
async function newMachine(kind: "join" | "claim", argv: string[]): Promise<number> {
  const { f, pos } = flags(argv, INIT_BOOLS), cmd = kind === "join" ? "kitebook join" : "kitebook login";
  const server = (pos[0] ?? "").replace(/\/+$/, "");
  if (!/^https?:\/\/[^/\s]+$/.test(server)) { console.error(`usage: ${cmd} <https://your-kitebook> [--name <this computer>]${kind === "join" ? " [--account a]" : " [--secret]"} [--out ~/.kitebook/runner.json] [--force] [--new-key]`); return 2; }
  const { runnerName } = await import("./setup.ts"), name = runnerName(f.name ?? hostname()), slot = slotOf(name);
  const out = resolve((f.out ?? "~/.kitebook/runner.json").replace(/^~(?=$|\/)/, homedir()));
  if (existsSync(out) && !f.force) { console.error(`${out} already exists: this computer is already set up as a runner (kitebook doctor checks it). To set it up for ${server} anyway: add --force (or --out <another runner.json>)`); return 1; }
  if (f["new-key"]) { try { deviceStore().remove(slot + ".device"); } catch {} for (const x of [".presence", ".presence.pub", ".device", ".presence.key", ".device.key"]) rmSync(join(keyDir(), slot + x), { force: true }); }
  // keys first: the device key (no prompt; signs kitebook open links and this poll) and the presence key (asks the human for every signature)
  const dk = await deviceKey(slot); let ppub = presencePub(slot);
  // the optional Touch ID / Windows Hello shortcut: only when KITEBOOK_PRESENCE names a backend on purpose (kitebook password shortcut on, later)
  if (!ppub && process.env.KITEBOOK_PRESENCE) { try { ppub = await presenceBackend().create(slot); } catch (e: any) { console.error(`(no Touch ID / Windows Hello shortcut on this computer: ${e.message}.)`); } }
  // the master password (client/password.ts): a person at a terminal sets it now. kitebook login (this computer becomes the OWNER) needs it;
  // kitebook join may skip it: a machine that only runs agents (a cloud VM) needs none, and it can't approve anything without one.
  // No terminal: none now; login prints a one-time setup link once claimed, join says how to add one later.
  const PW = await import("./password.ts"); let pwNew: Awaited<ReturnType<typeof PW.wrapNew>> | null = null, pwpub = PW.passwordPub(slot);
  if (!pwpub && !f["no-password"] && PW.canPrompt()) {
    const pw = await PW.promptNew({ intro: kind === "claim" ? "Choose a master password for Kitebook on this computer. It confirms it's you when you approve a computer, an app or more access; it stays on this computer."
      : "Choose a master password for Kitebook on this computer, so you can approve things from it. A machine that only runs agents (a cloud VM, a CI box) needs none.", allowEmpty: kind === "join" });
    if (pw) { pwNew = await PW.wrapNew(pw, kind); pwpub = pwNew.pub; }
    else if (pw === null && kind === "claim") { console.error("No master password: nothing was claimed. Run kitebook login again (or add --no-password to claim it locked and set the password later)."); return 1; }
  }
  let secret: string | undefined;
  if (kind === "claim" && f.secret) { secret = f.secret !== "1" ? f.secret : process.env.KITEBOOK_OWNER_CLAIM; if (!secret) { console.error("--secret: set KITEBOOK_OWNER_CLAIM to the claim secret you deployed the server with (kept out of your shell history), or pass --secret <value>"); return 2; } }
  let s: any; try { s = await post(`${server}/${kind}/start`, { name, os: osName(), pubkey: dk.pub, presence_key: ppub ?? undefined, password_key: pwpub ?? undefined, ...(kind === "join" && f.account ? { account: f.account } : {}), ...(secret ? { secret } : {}) }); }
  catch (e: any) { console.error(`can't reach ${server} (${e?.code ?? e?.message ?? e})`); return 1; }
  if (!s.ok) { console.error(`${cmd}: ${s.error}`); return 1; }
  const st = s.result, code = st.user_code;
  if (st.approved) console.log(`Claimed ${server} with its KITEBOOK_OWNER_CLAIM secret (it works once and is now used up).`);
  else if (kind === "join") console.log(`To add this computer ("${name}") to ${server}, approve code\n\n    ${code}\n\non one of your devices: kitebook approve ${code}   (or Settings -> Devices: ${st.verification_uri})\nCheck that it shows this computer's name. The code expires in ${mins(st.expires_in)}. Waiting...`);
  else console.log(`To claim ${server}, this code must show on its shell too:\n\n    ${code}\n\nOn the server's shell run: kitebook owner approve ${code}\nThe code expires in ${mins(st.expires_in)}. Waiting...`);
  // poll (RFC 8628): each poll is signed by the device key, so a leaked device code alone never gets the token
  const end = Date.now() + st.expires_in * 1000 + 5000; let every = Math.max(1, Number(st.interval) || 5);
  for (let first = true; Date.now() < end; first = false) {
    if (!first || !st.approved) await Bun.sleep(every * 1000);
    const sig = await dk.sign(`kitebook-join:v1.${st.device_code}`); let p: any;
    try { p = await post(`${server}/${kind}/poll`, { device_code: st.device_code, sig, ...(kind === "join" && f.account ? { account: f.account } : {}) }); } catch { continue; } // a blip: keep polling
    const r = p.result ?? {};
    if (r.state === "pending") continue;
    if (r.state === "denied") { console.error(`Code ${code} was denied. Nothing was set up.`); return 1; }
    if (r.state === "expired") { console.error(`Code ${code} expired (codes last 10 minutes). Run ${cmd} ${server} again.`); return 1; }
    if (r.state !== "approved") { console.error(`${cmd}: ${p.error ?? r.state}`); return 1; }
    const c = r.result;
    if (pwNew) PW.commit(slotOf(c.name), pwNew.file); // the key file once the server registered its public half
    console.log(kind === "claim" ? `Approved: this computer is now the owner device of ${server} (${c.device}).` : `Approved: "${c.name}" joined ${server} as a device (${c.device}).`);
    // the device state the runner and kitebook approve/open/confirm read (client/device.ts), so this machine acts as a device right away
    try { const { writeFileSync, mkdirSync } = await import("fs"); mkdirSync(join(homedir(), ".kitebook"), { recursive: true, mode: 0o700 });
      writeFileSync(join(homedir(), ".kitebook", `device-${slotOf(c.name)}.json`), JSON.stringify({ slot: slotOf(c.name), url: server, account: c.account, id: c.device, state: "active", pub: dk.pub, presence_pub: ppub, keystore: dk.store, presence: presenceBackend().name, gate: true }, null, 1), { mode: 0o600 }); } catch {}
    const { initCmd } = await import("./setup.ts");
    const rest = ["roots", "approve", "release-key"].flatMap(k => f[k] ? [`--${k}`, f[k]] : []).concat(["no-install", "verbose", "phone"].flatMap(k => f[k] ? [`--${k}`] : []));
    const rc = await initCmd([server, "--out", out, "--name", c.name, "--force", ...rest], { claimed: c });
    if (rc === 0) console.log(kind === "claim" ? "This computer is the owner now: kitebook open signs your browser in; add more computers with kitebook join " + server + " and approve them here."
      : "Revoking this device (kitebook devices revoke, or Settings -> Devices) ends its runner.");
    if (rc === 0 && !pwpub) { const cfgP = out; // no master password: say how to add one; an owner without one gets the one-time link now
      if (kind === "claim" && !f["no-link"]) { try { const l = await PW.mintLink(slotOf(c.name), cfgP); await post(`${server}/v1/device_setup`, { url: l.url, expires: l.expires }, JSON.parse(readFileSync(cfgP, "utf8")).token).catch(() => {});
        console.log(`\nThis computer has no master password yet, so it is LOCKED: nothing can be approved from it. A person opens this one-time link here and types it\n(15 minutes, once; an agent hands it over and never opens it):\n\n    ${l.url}\n\nOr later in a terminal: kitebook password set`); } catch (e: any) { console.log(`\nNo master password yet (locked): run kitebook password set in a terminal. (${e.message})`); } }
      else console.log(kind === "claim" ? "No master password yet (locked): run kitebook password set in a terminal." : "No master password on this computer: it runs tasks but can't approve anything. To approve from here later, allow it on one of your devices (Settings -> Devices -> Allow a password), then run kitebook password set here."); }
    return rc;
  }
  console.error(`Code ${code} expired (codes last 10 minutes). Run ${cmd} ${server} again.`); return 1;
}
export const joinCli = (argv: string[]) => newMachine("join", argv);
export const claimCli = (argv: string[]) => newMachine("claim", argv);

// ---- an owner device: kitebook approve <code> [yes|no] ----
const cfgOf = (f: string | undefined) => { const p = f ?? process.env.KITEBOOK_RUNNER_CONFIG ?? join(process.env.KITEBOOK_HOME || join(homedir(), ".kitebook"), "runner.json");
  try { const c = JSON.parse(readFileSync(p, "utf8")); return { url: String(c.url).replace(/\/+$/, ""), token: String(c.token) }; } catch { return null; } };
const api = async (c: { url: string; token: string }, op: string, a: any = {}) => { const j = await post(`${c.url}/v1/${op}`, a, c.token); if (!j.ok) throw new Error(j.error ?? "failed"); return j.result; };
export const describe = (m: any) => [`  ${m.code}  "${m.name}"  ${m.os}`, `        from ${m.ip}${m.location ? ` (${m.location})` : " (place unknown: this server has no location data)"}, asked ${new Date(m.requested).toLocaleTimeString()}, expires ${new Date(m.expires).toLocaleTimeString()}`].join("\n");
export async function approveJoinCli(argv: string[], cfgPath?: string): Promise<number> {
  const { f, pos } = flags(argv, ["yes", "json"]), code = norm(pos[0] ?? ""), word = (pos[1] ?? "").toLowerCase();
  const c = cfgOf(cfgPath); if (!c) { console.error("This computer isn't one of your Kitebook devices (no runner.json). Approve on one that is, or from the server shell: bun client/admin.ts join_approve"); return 1; }
  try {
    let m: any; try { m = await api(c, "join_show", { code }); } catch (e: any) { // not a machine joining: the code an app's POST /connect (or a device grant) showed
      const r = await approveDeviceCode(c, code, word, !!f.yes, cfgPath); if (r !== null) return r; throw e; }
    console.log(`A computer wants to join your Kitebook:\n${describe(m)}\n\n  ${m.warning}\n`);
    if (word === "no" || word === "deny") { await api(c, "join_deny", { code }); console.log(`Denied ${code}. That computer gets nothing.`); return 0; }
    if (word !== "yes" && !f.yes) {
      if (!process.stdin.isTTY) { console.error(`Not approved: add yes to approve (kitebook approve ${code} yes) or no to deny.`); return 1; }
      process.stdout.write(`Approve "${m.name}"? [y/N] `); const a = (await new Promise<string>(z => process.stdin.once("data", d => z(String(d))))).trim().toLowerCase(); process.stdin.pause();
      if (a !== "y" && a !== "yes") { await api(c, "join_deny", { code }); console.log(`Denied ${code}.`); return 0; }
    }
    const DV = await import("./device.ts"), s = await DV.mine(c); if (!s?.id || s.state !== "active") { console.error("This computer isn't an active owner device yet (start its runner once: kitebook start)."); return 1; }
    const pa = await DV.presenceAssert(s, `join_approve:${code}`, `approve the computer ${m.name} joining`);
    if (!pa) { console.error("Not confirmed (no master password or Touch ID / Windows Hello given here). Nothing was approved."); return 1; }
    const r = await api(c, "join_approve", { code, presence: pa });
    console.log(`Approved: "${r.name}" (${r.device}) is now one of your devices and starts as a runner. Revoke it any time: kitebook devices revoke ${r.device}`); return 0;
  } catch (e: any) { console.error(`kitebook approve: ${e.message}`); return 1; }
}
// An app's connection code (POST /connect, the device grant: XXXX-XXXX; the docs offer kitebook approve as the fallback for the /device
// page): approved by this owner device's presence (master password / Touch ID), bound to exactly that code, as the page itself does
// (src/oauth.ts devicePage op approve + presence). null: the server doesn't know it as a connection code either (the caller reports the join error).
export async function approveDeviceCode(c: { url: string; token: string }, code: string, word: string, yes: boolean, cfgPath?: string): Promise<number | null> {
  const dev = (b: any) => post(`${c.url}/device`, { user_code: code, ...b }).catch((e: any) => ({ error: "unreachable", error_description: e.message }));
  if (word === "no" || word === "deny") { console.error(`Not denied: a connection code is denied on its page (${c.url}/device?user_code=${code}), or let it expire (10 minutes).`); return 1; }
  if (word !== "yes" && !yes) {
    if (!process.stdin.isTTY) { console.error(`Not approved: add yes to approve the app that showed you ${code} (kitebook approve ${code} yes).`); return 1; }
    process.stdout.write(`Connect the app that showed you the code ${code} to your Kitebook (it can read every folder and send tasks you approve)? [y/N] `);
    const a = (await new Promise<string>(z => process.stdin.once("data", d => z(String(d))))).trim().toLowerCase(); process.stdin.pause(); if (a !== "y" && a !== "yes") { console.log("Not approved."); return 0; }
  }
  const DV = await import("./device.ts"), s = await DV.mine(c); if (!s?.id || s.state !== "active") { console.error("This computer isn't an active owner device yet (start its runner once: kitebook start)."); return 1; }
  const pa = await DV.presenceAssert(s, `device_grant:${code}`, `connect the app with code ${code}`);
  if (!pa) { console.error("Not confirmed (no master password or Touch ID / Windows Hello given here). Nothing was approved."); return 1; }
  const r: any = await dev({ op: "approve", presence: pa });
  if (r?.ok && r.passkey) { console.log(`Added: ${r.name}. It can approve with its passkey now (remove it any time in Settings -> Devices).`); return 0; } // a phone's passkey (src/passkey.ts)
  if (r?.ok) { console.log(`Approved: ${r.name} is connected${r.granted ? ` (${r.granted})` : ""}. It finishes connecting on its own.`); return 0; }
  if (r?.error === "invalid_grant") return null; // unknown to the device grant too
  console.error(`kitebook approve: ${r?.error_description ?? r?.error ?? "not approved"}`); return 1;
}
// `kitebook approve` with no code: the machines waiting to join, above the task approvals
export async function pendingJoins(cfgPath?: string): Promise<void> {
  const c = cfgOf(cfgPath); if (!c) return;
  try { const l = (await api(c, "join_list")).pending as any[]; if (!l.length) return;
    console.log(`Computers waiting to join (kitebook approve <code>):\n${l.map(describe).join("\n")}\n`); } catch {} // not an owner device / older server: nothing to show
}

// ---- the server's shell: kitebook owner ... (its ADMIN_TOKEN, read from .dev.vars / the data volume, never typed) ----
function adminToken(): string {
  if (process.env.KITEBOOK_ADMIN_TOKEN) return process.env.KITEBOOK_ADMIN_TOKEN;
  const dirs = [process.cwd(), process.env.KITEBOOK_SERVER_DIR, join(homedir(), ".kitebook-app"), join(homedir(), "kitebook")].filter(Boolean) as string[];
  for (const d of dirs) { try { const t = readFileSync(join(d, ".dev.vars"), "utf8").match(/^ADMIN_TOKEN=(.*)$/m)?.[1]?.trim(); if (t) return t; } catch {} }
  for (const f of [process.env.KITEBOOK_ADMIN_TOKEN_FILE, join(process.env.KITEBOOK_DATA ?? "/data", "admin-token")].filter(Boolean) as string[]) { try { const t = readFileSync(f, "utf8").trim(); if (t) return t; } catch {} }
  return "";
}
export async function ownerCli(argv: string[]): Promise<number> {
  const { f, pos } = flags(argv, ["yes", "json"]), [sub = "status", code0] = pos;
  const url = (process.env.KITEBOOK_URL ?? `http://127.0.0.1:${process.env.PORT ?? "7820"}`).replace(/\/+$/, ""), T = adminToken();
  const usage = "usage (on the server's shell): kitebook owner [status | pending | approve <code> | deny <code> | reset | reset-password [<device id>]]";
  if (!["status", "pending", "approve", "deny", "reset", "reset-password"].includes(sub)) { console.error(usage); return 2; }
  if (!T) { console.error("kitebook owner runs on the server's own shell: no ADMIN_TOKEN found (KITEBOOK_ADMIN_TOKEN, .dev.vars, or $KITEBOOK_DATA/admin-token)"); return 2; }
  const adm = async (cmd: string, a: any = {}) => { let j: any; try { j = await post(`${url}/admin/${cmd}`, a, T); } catch (e: any) { throw new Error(`can't reach the server at ${url} (${e?.code ?? e?.message ?? e}); set KITEBOOK_URL`); } if (!j.ok) throw new Error(j.error); return j.result; };
  try {
    if (sub === "status") { const s = await adm("claim_status"); if (f.json) { console.log(JSON.stringify(s)); return 0; }
      console.log(s.mode === "off" ? "This server isn't in claim mode (its first device is its own runner)." : !s.claimed ? `Unclaimed: waiting for its owner (${s.waiting} code${s.waiting === 1 ? "" : "s"} pending). On your computer: kitebook login ${url}` : s.open ? "Claim reopened (kitebook owner reset): the next approved kitebook login becomes an owner device." : "Claimed: this server has its owner; the claim is closed.");
      return 0; }
    if (sub === "pending") { const l = (await adm("claim_pending")).pending as any[]; if (!l.length) { console.log("No claim waits."); return 0; } for (const m of l) console.log(describe(m)); return 0; }
    // a forgotten master password: the server forgets that device's password key and lets it set a new one for 15 minutes. When that
    // device is this computer (the usual self-hosted case), a one-time setup link is made right here (or kitebook password set in a terminal).
    if (sub === "reset-password") { const r = await adm("device_password_reset", code0 ? { id: code0 } : {});
      console.log(`Reset: "${r.name}" (${r.id}) may set a new master password until ${new Date(r.reset_until).toLocaleTimeString()} (15 minutes).${r.shortcut ? " Its Touch ID / Windows Hello shortcut still works meanwhile." : ""}`);
      const cfgP = process.env.KITEBOOK_RUNNER_CONFIG || join(process.env.KITEBOOK_HOME || join(homedir(), ".kitebook"), "runner.json"), DV = await import("./device.ts"), c = cfgOf(cfgP), s = c ? await DV.mine(c).catch(() => null) : null;
      if (s?.id === r.id) { const PW = await import("./password.ts"); return await PW.passwordCli([PW.canPrompt() ? "set" : "link"], cfgP); }
      console.log(`On that computer, run: kitebook password set  (or kitebook password link for a one-time link)`); return 0; }
    if (sub === "reset") { const r = await adm("claim_reset"); console.log(`Claim reopened. ${r.note}`); if (r.devices.length) console.log("Devices now:\n" + r.devices.map((d: any) => `  ${d.id}  ${d.name}  ${d.os}${d.revoked ? "  (revoked)" : ""}`).join("\n")); return 0; }
    const code = norm(code0 ?? ""); if (!JOIN_CODE_RE.test(code)) { console.error(`${usage}\n(the code looks like ABCD-EFGH; kitebook owner pending lists them)`); return 2; }
    const m = await adm("claim_show", { code });
    console.log(`Claim request:\n${describe(m)}\n\n  ${m.warning}\n`);
    if (sub === "deny") { await adm("claim_deny", { code }); console.log(`Denied ${code}.`); return 0; }
    const r = await adm("claim_approve", { code });
    console.log(`Approved: "${r.name}" (${r.device}) is this server's owner device. The claim is closed (kitebook owner reset reopens it).`); return 0;
  } catch (e: any) { console.error(`kitebook owner ${sub}: ${e.message}`); return 1; }
}
