// This machine's keys (auth phase "device identity"; the server side is src/devices.ts). Two P-256 keypairs per device:
//   device key    no prompt. The runner signs `kitebook open` links with it; registered as the device at the runner's first start.
//   presence key  every signature needs the human. Only it signs presence assertions (approve a device/app/join code, widen access,
//                 owner rules, Run tasks without asking or Experimental on), and the server checks that signature, not the UI.
// Both backends are pluggable (KITEBOOK_KEYSTORE / KITEBOOK_PRESENCE override the platform default; tests use "file" + "fake").
// Since the master password (client/password.ts, 2026-10-22) the presence key here is the OPTIONAL shortcut: Touch ID / Windows Hello / the
// Keychain dialog. The baseline is the password key next to it, so a broken helper or a missing biometric sensor never locks the owner out.
// A new device gets no shortcut by itself (kitebook password shortcut on, or the installer's question at a terminal); an explicit
// KITEBOOK_PRESENCE=<backend> still makes one at the runner's first start, and a device from before keeps the one it has.
//   device key:   macOS Keychain (security CLI) · Windows DPAPI (CurrentUser) · Linux Secret Service (secret-tool) · else a 0600 file
//   presence key: macOS Secure Enclave with a user-presence ACL (the kitebook-se helper, scripts/kitebook-se.swift, when installed:
//                 Touch ID / password on EVERY signature, enforced by the chip) · else a Keychain item whose ACL trusts no app, so every
//                 read raises the macOS keychain password dialog · Windows: DPAPI key + a Windows Hello check before each signature ·
//                 Linux: a 0600 key + your OS password (su) in a terminal before each signature.
// Residual risk, plainly: the Windows and Linux presence gates (and the Keychain dialog, to a lesser degree) are enforced by this code, not
// by hardware. A local agent running as you can read the Linux 0600 key file (or a DPAPI blob) and sign without asking; the prompt then is
// a tripwire, like the approval file checks in client/local-approve.ts. Only the Secure Enclave path makes the key itself refuse. Keep
// coding agents in their worktree (access "worktree", the guard) and prefer a Mac with the helper for the owner's main device.
import "./brand.ts";
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, chmodSync } from "fs";
import { join } from "path";
import { homedir, userInfo } from "os";

export const keyDir = () => join(homedir(), ".kitebook", "keys");
const b64u = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64url");
const run = (argv: string[], input?: string) => { try { const r = Bun.spawnSync(argv, { stdin: input !== undefined ? Buffer.from(input) : "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true } as any);
  return { ok: r.exitCode === 0, out: new TextDecoder().decode(r.stdout).trim() }; } catch { return { ok: false, out: "" }; } };
const has = (bin: string) => !!Bun.which(bin);
const slotOk = (s: string) => { if (!/^[A-Za-z0-9_.-]{1,80}$/.test(s)) throw new Error("bad key slot " + s); return s; };

// ---- secret storage (a private key as base64url PKCS#8) ----
export type Store = { name: string; load(slot: string): string | null; save(slot: string, v: string): void; remove(slot: string): void };
const fileStore: Store = { name: "file",
  load: s => { try { return readFileSync(join(keyDir(), slotOk(s) + ".key"), "utf8").trim() || null; } catch { return null; } },
  save: (s, v) => { mkdirSync(keyDir(), { recursive: true, mode: 0o700 }); try { chmodSync(keyDir(), 0o700); } catch {} const f = join(keyDir(), slotOk(s) + ".key"); writeFileSync(f, v, { mode: 0o600 }); try { chmodSync(f, 0o600); } catch {} },
  remove: s => rmSync(join(keyDir(), slotOk(s) + ".key"), { force: true }) };
// macOS: a generic password item. trust = the apps that may read it without a dialog ("" = none: every read asks for the keychain password)
const keychain = (service: string, trust: string): Store => ({ name: trust ? "keychain" : "keychain-acl",
  load: s => { const r = run(["security", "find-generic-password", "-a", slotOk(s), "-s", service, "-w"]); return r.ok && r.out ? r.out : null; },
  save: (s, v) => { const r = run(["security", "add-generic-password", "-U", "-a", slotOk(s), "-s", service, "-l", `Kitebook ${service}`, "-w", v, "-T", trust]); if (!r.ok) throw new Error("couldn't save the key in the Keychain"); },
  remove: s => { run(["security", "delete-generic-password", "-a", slotOk(s), "-s", service]); } });
// Windows: DPAPI (CurrentUser scope) around the key, stored next to the file backend's
const ps = (script: string, input?: string) => run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], input);
const dpapi: Store = { name: "dpapi",
  load: s => { const f = join(keyDir(), slotOk(s) + ".dpapi"); if (!existsSync(f)) return null;
    const r = ps(`Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String((Get-Content -Raw '${f.replace(/'/g, "''")}').Trim()); [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))`); return r.ok && r.out ? r.out : null; },
  save: (s, v) => { mkdirSync(keyDir(), { recursive: true }); const f = join(keyDir(), slotOk(s) + ".dpapi");
    const r = ps(`Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd().Trim(); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($v),$null,'CurrentUser')) | Set-Content -NoNewline '${f.replace(/'/g, "''")}'`, v); if (!r.ok) throw new Error("couldn't protect the key with DPAPI"); },
  remove: s => rmSync(join(keyDir(), slotOk(s) + ".dpapi"), { force: true }) };
// Linux desktop: the Secret Service (GNOME Keyring / KWallet) through secret-tool; needs a session bus
const secretService: Store = { name: "secret-service",
  load: s => { const r = run(["secret-tool", "lookup", "service", "kitebook", "slot", slotOk(s)]); return r.ok && r.out ? r.out : null; },
  save: (s, v) => { const r = run(["secret-tool", "store", "--label", `Kitebook ${s}`, "service", "kitebook", "slot", slotOk(s)], v); if (!r.ok) throw new Error("secret-tool store failed"); },
  remove: s => { run(["secret-tool", "clear", "service", "kitebook", "slot", slotOk(s)]); } };
export function deviceStore(): Store {
  const want = process.env.KITEBOOK_KEYSTORE;
  if (want === "file") return fileStore; if (want === "keychain") return keychain("kitebook-device", "/usr/bin/security"); if (want === "dpapi") return dpapi; if (want === "secret-service") return secretService;
  if (process.platform === "darwin" && has("security")) return keychain("kitebook-device", "/usr/bin/security");
  if (process.platform === "win32") return dpapi;
  if (process.platform === "linux" && has("secret-tool") && process.env.DBUS_SESSION_BUS_ADDRESS) return secretService;
  return fileStore;
}

// ---- P-256 helpers (raw r||s signatures, raw public points: what the server and CryptoKit use) ----
export async function newKey(): Promise<{ priv: string; pub: string }> {
  const k = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  return { priv: b64u(await crypto.subtle.exportKey("pkcs8", k.privateKey) as ArrayBuffer), pub: "p256:" + b64u(await crypto.subtle.exportKey("raw", k.publicKey) as ArrayBuffer) };
}
export async function pubOf(priv: string): Promise<string> { // the public point from the PKCS#8 (via JWK: x, y)
  const k = await crypto.subtle.importKey("pkcs8", Buffer.from(priv, "base64url"), { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]), j: any = await crypto.subtle.exportKey("jwk", k);
  return "p256:" + b64u(new Uint8Array([4, ...Buffer.from(j.x, "base64url"), ...Buffer.from(j.y, "base64url")]));
}
export async function signWith(priv: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("pkcs8", Buffer.from(priv, "base64url"), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, k, new TextEncoder().encode(msg)));
}

// ---- the device key ----
export async function deviceKey(slot: string): Promise<{ pub: string; store: string; sign: (m: string) => Promise<string> }> {
  // The secure store first; else the 0600 file a failed secure-store write fell back to, so that identity is kept (not a new key each
  // start). When both hold a key (an older runner fell back once, then made a second key that the secure store took), the secure
  // store's is the newer one, the one the server knows.
  const st = deviceStore(), sec = st.load(slot + ".device"), fallback = sec || st === fileStore ? null : fileStore.load(slot + ".device"); let priv = sec ?? fallback;
  if (!priv) { const k = await newKey(); try { st.save(slot + ".device", k.priv); } catch { fileStore.save(slot + ".device", k.priv); return { pub: k.pub, store: "file", sign: m => signWith(k.priv, m) }; } priv = k.priv; }
  const p = priv; return { pub: await pubOf(p), store: fallback ? "file" : st.name, sign: m => signWith(p, m) };
}

// ---- the presence key ----
// sign(): null = the human didn't confirm (or can't here: no terminal, no helper); the caller says so and nothing is sent
export type Presence = { name: string; hardware: boolean; shortcut?: boolean; create(slot: string): Promise<string>; sign(slot: string, msg: string, reason: string): Promise<string | null> };
const pubFile = (slot: string) => join(keyDir(), slotOk(slot) + ".presence.pub");
const savePub = (slot: string, pub: string) => { mkdirSync(keyDir(), { recursive: true, mode: 0o700 }); writeFileSync(pubFile(slot), pub, { mode: 0o600 }); return pub; };
export const presencePub = (slot: string) => { try { return readFileSync(pubFile(slot), "utf8").trim() || null; } catch { return null; } };
// a software key kept in `store`, released only after `check` (the human) says yes
const gated = (name: string, store: Store, check: (reason: string) => boolean | Promise<boolean>): Presence => ({ name, hardware: false, shortcut: name !== "os-password",
  async create(slot) { const have = presencePub(slot); if (have) return have; const k = await newKey(); store.save(slot + ".presence", k.priv); return savePub(slot, k.pub); },
  async sign(slot, msg, reason) { if (!await check(reason)) return null; const priv = store.load(slot + ".presence"); return priv ? await signWith(priv, msg) : null; } });
// tests only: yes when KITEBOOK_FAKE_PRESENCE=yes, so smoke can show both answers; refuses to exist outside KITEBOOK_TEST
const fake = gated("fake", fileStore, () => process.env.KITEBOOK_FAKE_PRESENCE === "yes");
// tests only: a shortcut whose helper is broken (it was made fine, every signature throws), like a Secure Enclave helper that crashes
const fakeBroken: Presence = { ...gated("fake-broken", fileStore, () => true), async sign() { throw new Error("the Touch ID helper crashed (fake-broken)"); } };
// the shortcut's key and public half, gone (kitebook password shortcut off; the server forgets it the same moment)
export function dropPresence(slot: string) { for (const st of [fileStore, deviceStore()]) { try { st.remove(slot + ".presence"); } catch {} }
  if (process.platform === "darwin") try { keychain("kitebook-presence", "").remove(slot + ".presence"); } catch {}
  if (process.platform === "win32") try { dpapi.remove(slot + ".presence"); } catch {}
  rmSync(pubFile(slot), { force: true }); }
// macOS: the key lives in a Keychain item no app is trusted to read, so reading it (each signature) raises the system dialog
const keychainAcl = gated("keychain-acl", keychain("kitebook-presence", ""), () => true);
// Windows Hello (or the PIN) through the WinRT consent verifier, then the DPAPI key
const helloOk = (reason: string) => ps(`$null=[Windows.Security.Credentials.UI.UserConsentVerifier,Windows.Security.Credentials.UI,ContentType=WindowsRuntime]; Add-Type -AssemblyName System.Runtime.WindowsRuntime;
$m=([System.WindowsRuntimeSystemExtensions].GetMethods()|?{$_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'})[0].MakeGenericMethod([Windows.Security.Credentials.UI.UserConsentVerificationResult]);
$t=$m.Invoke($null,@([Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync('Kitebook: ${reason.replace(/'/g, "").slice(0, 80)}'))); if($t.Result -eq 'Verified'){'ok'}`).out === "ok";
const hello = gated("hello", dpapi, helloOk);
// Linux (and anything else): your OS password in this terminal (su to yourself runs PAM, which asks for it). No terminal: no presence.
const osPassword = gated("os-password", process.env.DBUS_SESSION_BUS_ADDRESS && has("secret-tool") ? secretService : fileStore, (reason) => {
  if (!process.stdin.isTTY || !has("su")) return false;
  console.error(`Kitebook needs your presence to ${reason}. Type your password for ${userInfo().username}:`);
  try { return Bun.spawnSync(["su", "-c", "true", userInfo().username], { stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exitCode === 0; } catch { return false; } });
// macOS Secure Enclave through the helper (a key that can't leave the chip; .userPresence on every signature)
export const seHelper = () => [join(homedir(), ".kitebook", "bin", "kitebook-se"), Bun.which("kitebook-se") ?? ""].find(p => p && existsSync(p)) ?? null;
const enclave: Presence = { name: "secure-enclave", hardware: true, shortcut: true,
  async create(slot) { const have = presencePub(slot); if (have) return have; const r = run([seHelper()!, "create", slotOk(slot)]); if (!r.ok || !/^p256:/.test(r.out)) throw new Error("kitebook-se create failed"); return savePub(slot, r.out); },
  async sign(slot, msg, reason) { const r = run([seHelper()!, "sign", slotOk(slot), reason.slice(0, 80)], msg); return r.ok && /^[A-Za-z0-9_-]{86}$/.test(r.out) ? r.out : null; } };
export function presenceBackend(): Presence {
  const want = process.env.KITEBOOK_PRESENCE;
  if (want === "fake" || want === "fake-broken") { if (!process.env.KITEBOOK_TEST) throw new Error(`KITEBOOK_PRESENCE=${want} is for tests (KITEBOOK_TEST=1) only`); return want === "fake" ? fake : fakeBroken; }
  if (want === "secure-enclave" && seHelper()) return enclave; if (want === "keychain-acl") return keychainAcl; if (want === "hello") return hello; if (want === "os-password") return osPassword;
  if (process.platform === "darwin") return seHelper() ? enclave : keychainAcl;
  if (process.platform === "win32") return hello;
  return osPassword;
}
