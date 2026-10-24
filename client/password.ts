// The master password (owner direction 2026-10-22): the BASELINE presence factor on every owner device, on every OS. Touch ID / Windows
// Hello (client/keystore.ts presenceBackend) is an optional shortcut next to it, never the only way: if the shortcut or its helper breaks,
// the password still confirms (client/device.ts presenceAssert tries the shortcut first, then asks for the password).
//   key       a third P-256 key per device, the "password presence key". Its private half lives only in ~/.kitebook/keys/<slot>.password.json
//             (0600), encrypted with AES-256-GCM under a key derived from the password with Argon2id (RFC 9106; bun's node:crypto
//             argon2Sync, 64 MiB, 3 passes, 1 lane), or scrypt (N=2^17, r=8) on a bun too old for Argon2, recorded in the file. The server
//             registers its PUBLIC half like any presence key and only ever verifies signatures: no password and no hash leave this machine.
//             It is Kitebook's own password, not the computer's (no su / PAM needed, so it works headless, on Linux, in a container).
//   wrong     attempts are counted here, with growing waits: three typos are free, then 30 s, 1 min, 2 min ... up to 15 min (<slot>.password.fails).
//             A local process can delete that file; what stops it is Argon2id's cost per guess on a copied key file, so pick a long password.
//   set       a human at a terminal: a hidden prompt, twice, at least 8 characters, with a strength hint (kitebook password set, the
//             installers, kitebook login). No terminal (an AI agent or a script installed Kitebook): the device stays LOCKED (no presence
//             key, so nothing that grants or widens access works) and gets a one-time local setup link instead,
//             http://127.0.0.1:<port>/setup-password#t=<token>: single use, 15 minutes, the token only in the #fragment, served by a small
//             process on this machine (kitebook password link starts it). The human opens it and types the password; the agent hands the link
//             over and never picks or sees the password. Residual risk, plainly: anything running as you on this machine could open that link
//             first (or set the first password with the runner's token); Settings shows when and how the password was set so you'd notice.
//   change    kitebook password change: the old password (or a working shortcut) signs the switch to the new key.
//   forgotten kitebook owner reset-password on the server's shell, or kitebook devices reset-password <id> from another trusted device:
//             the server forgets the key and lets that device set a new one for 15 minutes (kitebook password set there).
import "./brand.ts";
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, renameSync, openSync, closeSync, chmodSync, readdirSync } from "fs";
import { join, dirname } from "path";
import * as C from "crypto";
import { keyDir, newKey, signWith, presenceBackend, presencePub } from "./keystore.ts";

export const MIN_LEN = 8, SETUP_TTL = 15 * 60_000;
const slotOk = (s: string) => { if (!/^[A-Za-z0-9_.-]{1,80}$/.test(s)) throw new Error("bad key slot " + s); return s; };
export const pwFile = (slot: string) => join(keyDir(), slotOk(slot) + ".password.json");
const failFile = (slot: string) => join(keyDir(), slotOk(slot) + ".password.fails");
const setupFile = (slot: string) => join(keyDir(), slotOk(slot) + ".setup.json");
const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const writeSecret = (f: string, s: string) => { mkdirSync(dirname(f), { recursive: true, mode: 0o700 }); try { chmodSync(dirname(f), 0o700); } catch {} const t = f + ".tmp" + process.pid; writeFileSync(t, s, { mode: 0o600 }); renameSync(t, f); };

// ---- the key file ----
export type Kdf = { alg: "argon2id"; m: number; t: number; p: number } | { alg: "scrypt"; N: number; r: number; p: number };
export const defaultKdf = (): Kdf => typeof (C as any).argon2Sync === "function" && process.env.KITEBOOK_PW_KDF !== "scrypt" ? { alg: "argon2id", m: 65536, t: 3, p: 1 } : { alg: "scrypt", N: 1 << 17, r: 8, p: 1 };
export function derive(pw: string, kdf: Kdf, salt: Buffer): Buffer {
  const msg = Buffer.from(pw.normalize("NFC"), "utf8");
  if (kdf.alg === "argon2id") { if (typeof (C as any).argon2Sync !== "function") throw new Error("this password was set with Argon2id, which this bun can't compute: update bun (bun upgrade)");
    return (C as any).argon2Sync("argon2id", { message: msg, nonce: salt, parallelism: kdf.p, tagLength: 32, memory: kdf.m, passes: kdf.t }); }
  if (kdf.alg === "scrypt") return C.scryptSync(msg, salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * 1024 * 1024 });
  throw new Error("unknown key derivation " + (kdf as any).alg);
}
type PwFile = { v: 1; kdf: Kdf; salt: string; iv: string; ct: string; tag: string; pub: string; created: number; via: string };
const aad = (pub: string) => Buffer.from(`kitebook-password:v1:${pub}`);
// a new password key, wrapped with pw (nothing is written: commit() writes it once the server took the public half)
export async function wrapNew(pw: string, via = "terminal", kdf = defaultKdf(), made?: { priv: string; pub: string }): Promise<{ pub: string; file: PwFile }> {
  const k = made ?? await newKey(), salt = C.randomBytes(16), iv = C.randomBytes(12), key = derive(pw, kdf, salt);
  const c = C.createCipheriv("aes-256-gcm", key, iv); c.setAAD(aad(k.pub)); const ct = Buffer.concat([c.update(Buffer.from(k.priv, "utf8")), c.final()]);
  return { pub: k.pub, file: { v: 1, kdf, salt: b64u(salt), iv: b64u(iv), ct: b64u(ct), tag: b64u(c.getAuthTag()), pub: k.pub, created: Date.now(), via } };
}
export const commit = (slot: string, f: PwFile) => { writeSecret(pwFile(slot), JSON.stringify(f, null, 1)); rmSync(failFile(slot), { force: true }); };
export const readPw = (slot: string): PwFile | null => { try { const f = JSON.parse(readFileSync(pwFile(slot), "utf8")); return f?.v === 1 && /^p256:/.test(f.pub) ? f : null; } catch { return null; } };
export const passwordPub = (slot: string) => readPw(slot)?.pub ?? null;
export const hasPassword = (slot: string) => !!readPw(slot);
export const forget = (slot: string) => { rmSync(pwFile(slot), { force: true }); rmSync(failFile(slot), { force: true }); };
// the private key, or null for a wrong password (AES-GCM's tag fails)
export function unwrap(f: PwFile, pw: string): string | null {
  try { const d = C.createDecipheriv("aes-256-gcm", derive(pw, f.kdf, Buffer.from(f.salt, "base64url")), Buffer.from(f.iv, "base64url")); d.setAAD(aad(f.pub)); d.setAuthTag(Buffer.from(f.tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(f.ct, "base64url")), d.final()]).toString("utf8"); } catch (e: any) { if (/can't compute|unknown key/.test(e?.message)) throw e; return null; }
}

// ---- wrong attempts: local, growing waits ----
const FREE = 3, MAXWAIT = 15 * 60_000;
const base = () => process.env.KITEBOOK_TEST && Number(process.env.KITEBOOK_PW_DELAY_MS) > 0 ? Number(process.env.KITEBOOK_PW_DELAY_MS) : 30_000;
const fails = (slot: string): { n: number; until: number } => { try { const j = JSON.parse(readFileSync(failFile(slot), "utf8")); return { n: Number(j.n) || 0, until: Number(j.until) || 0 }; } catch { return { n: 0, until: 0 }; } };
export const waitLeft = (slot: string) => Math.max(0, fails(slot).until - Date.now());
const secs = (ms: number) => ms >= 90_000 ? `${Math.ceil(ms / 60_000)} min` : `${Math.ceil(ms / 1000)} s`;
// unlock: the private key; throws with a plain reason (wrong, or wait N s after too many wrong ones)
export function unlock(slot: string, pw: string): string {
  const f = readPw(slot); if (!f) throw new Error("this computer has no master password yet (kitebook password set)");
  const w = waitLeft(slot); if (w > 0) throw new Error(`too many wrong master passwords on this computer; try again in ${secs(w)}`);
  const priv = unwrap(f, pw);
  if (priv) { rmSync(failFile(slot), { force: true }); return priv; }
  const n = fails(slot).n + 1, wait = n > FREE ? Math.min(MAXWAIT, base() * 2 ** (n - FREE - 1)) : 0;
  writeSecret(failFile(slot), JSON.stringify({ n, until: Date.now() + wait }));
  throw new Error(`wrong master password${wait ? ` (${n} wrong in a row: the next try waits ${secs(wait)})` : ""}`);
}

// ---- strength ----
const COMMON = new Set(["password", "password1", "12345678", "123456789", "1234567890", "qwertyuiop", "11111111", "iloveyou", "kitebook", "letmein1", "abc12345", "passw0rd", "00000000", "qwerty123", "admin123", "welcome1"]);
// null = fine; else why not (too short) or a hint (weak, still allowed)
export function check(pw: string): { ok: boolean; why?: string; hint?: string } {
  if ([...pw].length < MIN_LEN) return { ok: false, why: `at least ${MIN_LEN} characters` };
  if (COMMON.has(pw.toLowerCase())) return { ok: false, why: "that one is on every list of common passwords" };
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(r => r.test(pw)).length, len = [...pw].length;
  if (len < 12 && classes < 3) return { ok: true, hint: "weak: longer is stronger (12+ characters, or a few unrelated words like 'cactus river lamp tuesday')" };
  if (/^(.)\1+$/.test(pw)) return { ok: true, hint: "weak: one repeated character" };
  return { ok: true, hint: len >= 16 ? undefined : "ok; a few more characters make it much harder to guess" };
}

// ---- the terminal ----
// a hidden prompt needs a human at a terminal. Tests (KITEBOOK_TEST) never use the real one: KITEBOOK_TEST_PASSWORD holds the answers
// (one per line, used in order); unset = no terminal, as for an agent or a script.
let testAnswers: string[] = [], testEnv: string | undefined; // re-read when the variable changes or runs out (callers stop after 3 tries)
export function canPrompt(): boolean {
  if (process.env.KITEBOOK_TEST) return process.env.KITEBOOK_TEST_PASSWORD != null;
  if (process.env.KITEBOOK_NO_TTY === "1") return false;
  if (process.platform === "win32") return !!process.stdin.isTTY;
  try { closeSync(openSync("/dev/tty", "r")); return true; } catch { return false; }
}
const say = (s: string) => { try { if (process.platform !== "win32" && !process.env.KITEBOOK_TEST) { const fd = openSync("/dev/tty", "w"); writeFileSync(fd, s); closeSync(fd); return; } } catch {} process.stderr.write(s); };
export async function readHidden(prompt: string): Promise<string | null> {
  if (process.env.KITEBOOK_TEST) { const e = process.env.KITEBOOK_TEST_PASSWORD; if (e !== testEnv || !testAnswers.length) { testEnv = e; testAnswers = e == null ? [] : e.split("\n"); } if (!testAnswers.length) return null; process.stderr.write(prompt + "\n"); return testAnswers.shift()!; }
  if (!canPrompt()) return null;
  if (process.platform === "win32") { // PowerShell's own hidden prompt; the answer comes back on its stdout, never in argv
    const r = Bun.spawnSync(["powershell.exe", "-NoProfile", "-Command", `$s=Read-Host -AsSecureString -Prompt '${prompt.replace(/'/g, "''").replace(/[:\s]+$/, "")}'; [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))`], { stdin: "inherit", stdout: "pipe", stderr: "inherit", windowsHide: false } as any);
    return r.exitCode === 0 ? new TextDecoder().decode(r.stdout).replace(/\r?\n$/, "") : null; }
  // sh does the read on /dev/tty with echo off and puts echo back on Ctrl-C too; the password reaches us on a pipe, never in argv or env
  const r = Bun.spawnSync(["sh", "-c", `exec </dev/tty; trap 'stty echo; printf "\\n" >/dev/tty; exit 130' INT TERM HUP; printf '%s' "$1" >/dev/tty; stty -echo; IFS= read -r p; s=$?; stty echo; printf '\\n' >/dev/tty; [ $s = 0 ] && printf '%s' "$p"`, "sh", prompt], { stdin: "inherit", stdout: "pipe", stderr: "inherit" });
  return r.exitCode === 0 ? new TextDecoder().decode(r.stdout) : null;
}
// a visible one-line answer (y/N) from the terminal; "" when there is none
export async function readVisible(prompt: string): Promise<string> {
  if (process.env.KITEBOOK_TEST || !canPrompt()) return "";
  if (process.platform === "win32") { process.stdout.write(prompt); return await new Promise<string>(z => process.stdin.once("data", d => { process.stdin.pause(); z(String(d)); })); }
  const r = Bun.spawnSync(["sh", "-c", `exec </dev/tty; printf '%s' "$1" >/dev/tty; IFS= read -r p && printf '%s' "$p"`, "sh", prompt], { stdin: "inherit", stdout: "pipe", stderr: "inherit" });
  return new TextDecoder().decode(r.stdout);
}
// a new password, typed twice. null: no terminal, or given up after 3 tries
export async function promptNew(o: { intro?: string; allowEmpty?: boolean } = {}): Promise<string | null | ""> {
  if (!canPrompt()) return null;
  if (o.intro) say(o.intro + "\n");
  for (let i = 0; i < 3; i++) {
    const a = await readHidden(`New master password (at least ${MIN_LEN} characters${o.allowEmpty ? "; Enter to skip" : ""}): `); if (a === null) return null;
    if (a === "" && o.allowEmpty) return "";
    const c = check(a); if (!c.ok) { say(`Not that one: ${c.why}.\n`); continue; }
    if (c.hint) say(`(${c.hint})\n`);
    const b = await readHidden("Type it again: "); if (b === null) return null;
    if (a !== b) { say("They don't match. Once more.\n"); continue; }
    return a;
  }
  say("No master password set.\n"); return null;
}

// ---- signing with the password (client/device.ts presenceAssert) ----
// null when nobody can type it here (no terminal), it isn't set, or 3 wrong tries / the wait after too many
export async function passwordSign(slot: string, msg: string, reason: string): Promise<string | null> {
  const f = readPw(slot); if (!f) return null;
  if (!canPrompt()) { process.stderr.write(`(Kitebook needs your master password to ${reason}, and there's no terminal here to type it. Run the same command yourself in a terminal.)\n`); return null; }
  for (let i = 0; i < 3; i++) {
    const w = waitLeft(slot); if (w > 0) { say(`Too many wrong master passwords on this computer; try again in ${secs(w)}.\n`); return null; }
    const pw = await readHidden(`Kitebook master password (to ${reason.slice(0, 80)}): `); if (pw === null || pw === "") return null;
    try { return await signWith(unlock(slot, pw), msg); } catch (e: any) { say(`${e.message}.\n`); if (/can't compute|unknown key/.test(e.message)) return null; }
  }
  return null;
}

// ---- the one-time local setup link (no terminal: an agent or a script installed Kitebook) ----
const COMPILED = /^(\/\$bunfs\/|[A-Z]:[\\/]~BUN[\\/])/i.test(import.meta.path);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sha = (s: string) => C.createHash("sha256").update(s).digest("hex");
const ttl = () => process.env.KITEBOOK_TEST && Number(process.env.KITEBOOK_SETUP_TTL_MS) > 0 ? Number(process.env.KITEBOOK_SETUP_TTL_MS) : SETUP_TTL;
// start the link's server (a detached process that ends after one use or at expiry) and return the link. Only its sha256 is in that
// process's arguments; the token itself is printed once, here.
export async function mintLink(slot: string, cfgPath: string): Promise<{ url: string; expires: number }> {
  try { const o = JSON.parse(readFileSync(setupFile(slot), "utf8")); if (o.pid && alive(o.pid)) process.kill(o.pid); } catch {} // one live link per device
  rmSync(setupFile(slot), { force: true });
  const t = b64u(C.randomBytes(32)), expires = Date.now() + ttl();
  const argv = [process.execPath, ...(COMPILED ? [] : [join(dirname(import.meta.path), "cli.ts")]), "password", "__serve", slot, cfgPath, sha(t), String(expires)];
  const { spawn } = await import("child_process"), ch = spawn(argv[0], argv.slice(1), { detached: true, stdio: "ignore", env: process.env }); ch.unref();
  for (let i = 0; i < 100; i++) { try { const o = JSON.parse(readFileSync(setupFile(slot), "utf8")); if (o.port && o.hash === sha(t)) return { url: `http://127.0.0.1:${o.port}/setup-password#t=${t}`, expires }; } catch {} await Bun.sleep(100); }
  throw new Error("the setup link's local page didn't start");
}
// kitebook uninstall: a link's server still waiting (detached, not under any service job) stops with the rest instead of outliving ~/.kitebook
export function stopLinks() { const d = keyDir(); let fs: string[] = []; try { fs = readdirSync(d).filter(f => f.endsWith(".setup.json")); } catch {}
  for (const f of fs) { try { const o = JSON.parse(readFileSync(join(d, f), "utf8")); if (o.pid && alive(o.pid)) process.kill(o.pid, "SIGTERM"); } catch {} rmSync(join(d, f), { force: true }); } }
export const setupPage = (port: number) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><meta name="color-scheme" content="light dark"><title>Set your Kitebook master password</title>
<style>/* the shared Kitebook look ("Quiet page", src/ui.ts), inlined: this page is served by the Mac's own helper, which can't import the server's files */
:root{color-scheme:light dark;--bg:#fff;--fg:#111418;--mut:#4a5160;--line:#e7e9ee;--soft:#f4f5f7;--acc:#0f6e5c;--acc2:#0b5a4b;--onacc:#fff;--danger:#b42318;--field:#858b97}
@media(prefers-color-scheme:dark){:root{--bg:#0f1113;--fg:#f1f3f5;--mut:#a9afba;--line:#262a30;--soft:#1a1d21;--acc:#3fd1b2;--acc2:#6fe0c7;--onacc:#06231d;--danger:#ff8a7a;--field:#666d78}}
*{box-sizing:border-box}body{margin:0 auto;max-width:34rem;padding:64px 24px 48px;background:var(--bg);color:var(--fg);font:17px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
h1{font-size:28px;line-height:1.25;letter-spacing:-.01em;margin:0 0 16px}label{display:block;margin:20px 0 6px;font-weight:600}
input{font:inherit;width:100%;min-height:48px;padding:12px 14px;border:1px solid var(--field);border-radius:12px;background:var(--bg);color:var(--fg)}input:focus{outline:none;border-color:var(--acc);box-shadow:0 0 0 3px color-mix(in srgb,var(--acc) 25%,transparent)}
button{font:inherit;font-weight:600;width:100%;min-height:52px;margin-top:24px;padding:12px 20px;border-radius:12px;border:0;background:var(--acc);color:var(--onacc);cursor:pointer}button:hover{background:var(--acc2)}button:disabled{opacity:.45}
:focus-visible{outline:3px solid var(--acc);outline-offset:2px}small,.hint{color:var(--mut);font-size:15px}.hint{min-height:1.5em;margin-top:6px}.err{color:var(--danger);font-weight:600}.ok{color:var(--acc);font-weight:600}</style></head><body>
<h1>Set your Kitebook master password</h1>
<p>This computer's Kitebook was installed without a terminal, so it is <b>locked</b>: nothing can be approved from it until you set its master password. Type it here yourself. <b>Don't give it to an AI agent</b>, and don't let one choose it: an agent that installed Kitebook hands you this link and stops there.</p>
<p><small>It stays on this computer: it protects the key that confirms it's you (approving a computer, an app, more access). Touch ID / Windows Hello can be added later as a shortcut; this password always works, even if they don't. This link works once and only for 15 minutes.</small></p>
<form id="f"><label for="a">Master password</label><input id="a" type="password" autocomplete="new-password" minlength="${MIN_LEN}" required><div id="h" class="hint" aria-live="polite"></div>
<label for="b">Type it again</label><input id="b" type="password" autocomplete="new-password" required><button>Set master password</button><p id="m" role="status"></p></form>
<script>const t=new URLSearchParams(location.hash.slice(1)).get("t")||"";history.replaceState(null,"",location.pathname);const $=i=>document.getElementById(i);
$("a").oninput=()=>{const v=$("a").value,c=[/[a-z]/,/[A-Z]/,/[0-9]/,/[^A-Za-z0-9]/].filter(r=>r.test(v)).length;$("h").textContent=!v?"":v.length<${MIN_LEN}?"At least ${MIN_LEN} characters.":v.length<12&&c<3?"Weak: longer is stronger (12+ characters, or a few unrelated words).":v.length<16?"OK; a few more characters make it much harder to guess.":"Strong."};
$("f").onsubmit=async e=>{e.preventDefault();const m=$("m");if($("a").value!==$("b").value){m.className="err";m.textContent="They don't match.";return}
m.className="";m.textContent="Setting it...";const r=await fetch("/setup-password",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({t,password:$("a").value,again:$("b").value})}).catch(()=>null);
const j=r?await r.json().catch(()=>({})):{error:"This page's local helper has stopped (the link expired or was used). Run kitebook password link for a new one."};
if(r&&r.ok){m.className="ok";m.textContent="Done. Your master password is set on this computer; you can close this tab.";$("f").querySelectorAll("input,button").forEach(x=>x.disabled=true)}else{m.className="err";m.textContent=j.error||"That didn't work."}};</script></body></html>`;
// the link's server: Bun.serve on 127.0.0.1, one POST that sets the password, then it exits. Stays up to expiry (+ a minute, to say so).
export async function serveSetup(slot: string, cfgPath: string, hash: string, expires: number): Promise<void> {
  let used = false, bad = 0;
  const j = (b: any, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  const srv: ReturnType<typeof Bun.serve> = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.KITEBOOK_SETUP_PORT) || 0, async fetch(req): Promise<Response> {
    const u = new URL(req.url), host = req.headers.get("host") ?? "", origin = req.headers.get("origin");
    if (host !== `127.0.0.1:${srv.port}` && host !== `localhost:${srv.port}`) return new Response("not found", { status: 404 }); // DNS rebinding
    if (u.pathname !== "/setup-password") return new Response("not found", { status: 404 });
    const sec = { "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'", "x-frame-options": "DENY", "referrer-policy": "no-referrer", "cache-control": "no-store" };
    if (req.method === "GET") return new Response(setupPage(Number(srv.port)), { headers: { "content-type": "text/html; charset=utf-8", ...sec } });
    if (req.method !== "POST") return j({ ok: false, error: "GET or POST" }, 405);
    if (origin && origin !== `http://127.0.0.1:${srv.port}` && origin !== `http://localhost:${srv.port}`) return j({ ok: false, error: "wrong origin" }, 403);
    if (used) return j({ ok: false, error: "This setup link was already used. To change the password: kitebook password change (in a terminal)." }, 410);
    if (Date.now() > expires) return j({ ok: false, error: "This setup link expired (they last 15 minutes). Run kitebook password link for a new one." }, 410);
    const b: any = await req.json().catch(() => ({}));
    if (typeof b.t !== "string" || sha(b.t) !== hash) { if (++bad >= 5) { used = true; setTimeout(() => process.exit(0), 300); } return j({ ok: false, error: "This isn't the current setup link (open the exact link you were given)." }, 403); }
    const pw = String(b.password ?? ""), c = check(pw);
    if (!c.ok) return j({ ok: false, error: `Not that one: ${c.why}.` }, 400);
    if (pw !== String(b.again ?? "")) return j({ ok: false, error: "They don't match." }, 400);
    if (hasPassword(slot)) { used = true; return j({ ok: false, error: "This computer already has a master password (set meanwhile). To change it: kitebook password change." }, 409); }
    used = true; // single use from here on, whatever happens next
    try { const r = await setLocal(slot, cfgPath, pw, "setup-link"); setTimeout(() => process.exit(0), 1500); return j({ ok: true, result: { registered: r.registered } }); }
    catch (e: any) { setTimeout(() => process.exit(1), 1500); return j({ ok: false, error: String(e?.message ?? e) }, 502); }
  } });
  writeSecret(setupFile(slot), JSON.stringify({ pid: process.pid, port: srv.port, hash, expires }));
  setTimeout(() => { try { rmSync(setupFile(slot), { force: true }); } catch {} process.exit(0); }, Math.max(0, expires - Date.now()) + 60_000);
}

// ---- the server side of setting it ----
const cfgOf = (p: string) => { try { const c = JSON.parse(readFileSync(p, "utf8")); return { url: String(c.url).replace(/\/+$/, ""), token: String(c.token), name: c.name ? String(c.name) : "" }; } catch { return null; } };
async function api(c: { url: string; token: string }, op: string, a: any = {}): Promise<any> {
  const r = await fetch(`${c.url}/v1/${op}`, { method: "POST", headers: { authorization: `Bearer ${c.token}`, "content-type": "application/json" }, body: JSON.stringify(a), signal: AbortSignal.timeout(20_000) });
  const j: any = await r.json().catch(() => ({})); if (!j.ok) throw Object.assign(new Error(j.error ?? `HTTP ${r.status}`), { status: r.status }); return j.result;
}
// a new password key: wrapped, registered with the server (proof from a key this device already has when the server wants one), then
// written. Not enrolled yet (the runner never started): written now, the runner registers it at its first start (client/device.ts).
// pre: a key made earlier and the proof already signed for it (kitebook password change asks for the OLD password before the new one)
export async function setLocal(slot: string, cfgPath: string, pw: string, via: string, proof?: (action: string) => Promise<string | null>, pre?: { key: { priv: string; pub: string }; presence: string }): Promise<{ pub: string; registered: boolean }> {
  const w = await wrapNew(pw, via, defaultKdf(), pre?.key), c = cfgOf(cfgPath);
  if (c) {
    const send = (presence?: string | null) => api(c, "device_password", { password_key: w.pub, via, ...(presence ? { presence } : {}) });
    try { await send(pre?.presence); }
    catch (e: any) {
      if (/isn't enrolled/.test(e.message)) { commit(slot, w.file); return { pub: w.pub, registered: false }; }
      if (e.status !== 428 || !proof) throw e;
      const a = await proof(`device_password:${w.pub.slice(5, 21)}`); if (!a) throw new Error("not confirmed: nothing was changed");
      await send(a);
    }
  }
  commit(slot, w.file); return { pub: w.pub, registered: !!c };
}

// ---- kitebook password ... ----
const LOCKED = (link: string, mins: number) => `This computer's Kitebook is LOCKED until a person sets its master password (nothing can be approved from it meanwhile).
Hand this one-time link to the person who owns this computer; they open it in a browser here and type the password themselves
(it works once, for ${mins} minutes; an agent must never open it or choose the password):

    ${link}

Later, or after it expires: kitebook password set (in a terminal) or kitebook password link (a new link).`;
export async function passwordCli(argv: string[], cfgPath: string): Promise<number> {
  const [sub = "status", ...rest] = argv.filter(a => !a.startsWith("--")), fl = new Set(argv.filter(a => a.startsWith("--")));
  if (sub === "__serve") { await serveSetup(rest[0], rest[1], rest[2], Number(rest[3])); return await new Promise<number>(() => {}); } // the link's process (mintLink)
  const DV = await import("./device.ts"), c = cfgOf(cfgPath);
  if (!c) { console.error("This computer isn't connected to Kitebook yet (no runner.json). Install it first."); return 1; }
  const s = await DV.mine(c), slot = s?.slot ?? DV.slotOf(c.name || (await api(c, "whoami").catch(() => ({ name: "" }))).name || "runner");
  const me = async () => { try { const l = await api(c, "device_list"); return l.devices.find((d: any) => d.id === l.me) ?? null; } catch { return null; } };
  // after a reset (kitebook owner reset-password, or another device's kitebook devices reset-password) the old key file here is dead
  const afterReset = async () => { const d = await me(); if (d && !d.password && d.password_reset && hasPassword(slot)) { forget(slot); console.log("(Your master password was reset: the old one is gone from this computer.)"); } };
  const link = async () => { const l = await mintLink(slot, cfgPath); await api(c, "device_setup", { url: l.url, expires: l.expires }).catch(() => {}); return l; };
  try {
    if (sub === "status") { const d = await me(), pw = readPw(slot), sc = !!presencePub(slot);
      if (fl.has("--json")) { console.log(JSON.stringify({ password: !!pw, kdf: pw?.kdf.alg ?? null, shortcut: sc, locked: !pw && !sc, server: d })); return 0; }
      console.log(`Master password: ${pw ? `set ✓ (${pw.kdf.alg}, ${new Date(pw.created).toLocaleString()})` : sc ? "not set yet: kitebook password set (Touch ID / Windows Hello works meanwhile)" : "not set: this computer is LOCKED (kitebook password set, or kitebook password link)"}`);
      console.log(`Shortcut (${presenceBackend().name}): ${sc ? "on" : "off"}${sc ? " (kitebook password shortcut off)" : pw ? " (optional: kitebook password shortcut on)" : ""}`);
      if (d && d.password !== !!pw) console.log(d.password ? "Note: Kitebook knows a master password for this computer that isn't saved here; kitebook password change (or ask for a reset) fixes it." : "Note: Kitebook doesn't know this computer's password yet; it is registered when the runner starts, or run kitebook password set again.");
      return 0; }
    if (sub === "set" || sub === "setup") { const inst = fl.has("--installer");
      // an installer runs this right after starting the runner: give it a moment to enroll this computer, so the link shows in Settings too
      if (fl.has("--wait")) for (let i = 0; i < 40 && !(await me()); i++) await Bun.sleep(500);
      await afterReset();
      if (hasPassword(slot)) { console.log(inst ? "✓ This computer already has its master password." : "This computer already has a master password. To change it: kitebook password change"); return inst ? 0 : 1; }
      if (!canPrompt()) { if (fl.has("--no-link")) { console.log("No terminal here, so no master password was set: this computer stays locked until a person runs kitebook password set."); return inst ? 0 : 3; }
        const l = await link();
        console.log(inst ? `! Locked until a person sets the master password: open ${l.url} on this computer and type it yourself (once, ${Math.round((l.expires - Date.now()) / 60_000)} minutes).\n  If an agent installed Kitebook for you, it hands you this link and never opens it. Later: kitebook password set` : LOCKED(l.url, Math.round((l.expires - Date.now()) / 60_000)));
        return inst ? 0 : 3; }
      const pw = await promptNew({ intro: "Choose a master password for Kitebook on this computer. It confirms it's you when you approve a computer, an app or more access (Touch ID / Windows Hello can be a shortcut later; this always works). It stays on this computer." });
      if (!pw) return 1;
      const r = await setLocal(slot, cfgPath, pw, fl.has("--installer") ? "install" : "terminal", s ? a => DV.presenceAssert(s, a, "set your master password") : undefined);
      console.log(r.registered ? "✓ Master password set. Kitebook asks for it when you approve something from this computer." : "✓ Master password set here; Kitebook registers it when this computer's runner starts.");
      // the optional shortcut, offered once at a terminal where one exists (macOS Touch ID / Keychain, Windows Hello); never needed
      const pb = presenceBackend(); if (inst && pb.shortcut && !presencePub(slot) && s?.id && process.platform !== "linux") {
        const yes = (await readVisible(`Also use ${process.platform === "darwin" ? "Touch ID" : "Windows Hello"} as a shortcut? Your master password always works too. [y/N] `)).trim().toLowerCase();
        if (yes === "y" || yes === "yes") return await passwordCli(["shortcut", "on"], cfgPath); }
      return 0; }
    if (sub === "change") {
      if (!s?.id) { console.error("This computer isn't an enrolled device yet: start its runner once (kitebook start)."); return 1; }
      if (!hasPassword(slot) && !presencePub(slot)) { console.error("No master password here yet: kitebook password set"); return 1; }
      if (!canPrompt()) { console.error("Changing the master password needs a person at a terminal: run kitebook password change yourself."); return 1; }
      const key = await newKey(), a = await DV.presenceAssert(s, `device_password:${key.pub.slice(5, 21)}`, "change your master password (the OLD one)");
      if (!a) { console.error("Not confirmed: the master password stays as it was."); return 1; }
      const pw = await promptNew({ intro: "Now choose the new master password." });
      if (!pw) { console.error("No new password: nothing was changed."); return 1; }
      const r = await setLocal(slot, cfgPath, pw, "change", undefined, { key, presence: a });
      console.log("✓ Master password changed" + (r.registered ? "." : " here; Kitebook registers it when the runner starts.")); return 0; }
    if (sub === "link") { await afterReset(); if (hasPassword(slot)) { console.log("This computer already has a master password. To change it: kitebook password change"); return 1; }
      const l = await link(); console.log(LOCKED(l.url, Math.round((l.expires - Date.now()) / 60_000))); return 0; }
    if (sub === "shortcut" || sub === "touchid") {
      const on = (rest[0] ?? "").toLowerCase(); if (on !== "on" && on !== "off") { console.error("kitebook password shortcut on|off   (Touch ID / Windows Hello next to your master password)"); return 2; }
      if (!s?.id) { console.error("This computer isn't an enrolled device yet: start its runner once (kitebook start)."); return 1; }
      const KS = await import("./keystore.ts");
      if (on === "off") { await api(c, "device_shortcut", { on: false }); KS.dropPresence(slot); DV.saveShortcut(s, null); console.log("Shortcut off. Your master password confirms it's you from now on."); return 0; }
      const pb = presenceBackend(); if (!pb.shortcut) { console.error(`No shortcut on this computer (${pb.name}): your master password is the way to confirm here.`); return 1; }
      if (!hasPassword(slot)) { console.error("Set a master password first (kitebook password set): the shortcut only sits next to it."); return 1; }
      KS.dropPresence(slot); const pub = await pb.create(slot);
      const a = await DV.assertWith(s, `device_shortcut:${pub.slice(5, 21)}`, m => passwordSign(slot, m, "turn on the shortcut"));
      if (!a) { KS.dropPresence(slot); console.error("Not confirmed: the shortcut stays off."); return 1; }
      await api(c, "device_shortcut", { on: true, presence_key: pub, presence: a });
      DV.saveShortcut(s, pub); console.log(`Shortcut on (${pb.name}). If it ever stops working, your master password still does.`); return 0; }
    if (sub === "reset") { const id = rest[0]; if (!id) { console.error("kitebook password reset <device id>   (another device's forgotten password; kitebook devices lists the ids)"); return 2; }
      return await DV.devicesCli(["reset-password", id]); }
    console.error("kitebook password [status | set | change | link | shortcut on|off | reset <device id>]"); return 2;
  } catch (e: any) { console.error(`kitebook password ${sub}: ${e.message}`); return 1; }
}
