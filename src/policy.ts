// The owner's standing permissions, kitebook side (the Permissions panel on /start, the consent page, the review page's "Always allow").
// The policy itself is signed in the owner's browser (P-256, WebCrypto, never extractable; client/payload.ts says what it holds), and
// the runner acts only on a policy signed by a key it pinned (client/policy.ts). The server keeps the latest one per workspace plus an
// audit list, checks each new one against the owner keys registered here (so a stale or forged one is refused early), and, for an app
// that can't sign its own tasks (Hark, Claude.ai, ChatGPT), holds an Ed25519 key per app and signs that app's tasks ONLY where the
// signed policy lets it run on its own. So that key adds nothing against a compromised Kitebook (it holds the key); what bounds it is the
// owner-signed policy: that app, those projects, that expiry, no push unless ticked. An app with its own key (kitebook keygen) is pinned
// in the policy instead, and stays end-to-end. Pure WebCrypto: runs in the Worker.
import { canon, policyMsg, POLICY_TYPE, dispatchPayload, dispatchMsg, autoEntry, cmdMsg, cmdShape, CMD_WINDOW_MS, type PolicyEntry } from "../client/payload.ts";

const te = new TextEncoder();
export const b64u = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b as ArrayBuffer))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => Uint8Array.from(atob(String(s).replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
export const sha256hex = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(s)))].map(b => b.toString(16).padStart(2, "0")).join("");
// what the panel shows next to a key and Settings shows next to each browser: sha256 of the key text, 16 hex in 4 groups
export const fingerprint = async (key: string) => (await sha256hex(String(key))).slice(0, 16).match(/..../g)!.join("-");
export const OWNER_KEY_RE = /^p256:[A-Za-z0-9_-]{80,200}$/, APP_KEY_RE = /^ed25519:[A-Za-z0-9_-]{43}$/;
export const ACCESS_MODES = ["shared", "folders", "read", "full"];

// null when env is a policy for `space` signed by one of `keys` (registered owner keys), else why not
export async function checkEnvelope(env: any, keys: string[], space: string): Promise<string | null> {
  if (!env || typeof env !== "object" || typeof env.sig !== "string" || typeof env.key !== "string" || typeof env.policy !== "object") return "envelope: {policy, key, sig}";
  const p = env.policy;
  if (p.v !== 1 || p.type !== POLICY_TYPE || p.space !== space || !Number.isInteger(p.seq) || p.seq < 1 || typeof p.apps !== "object" || Array.isArray(p.apps)) return "not a relay-policy v1 for this workspace";
  if (JSON.stringify(p).length > 32_000) return "policy too large";
  for (const [app, e] of Object.entries<any>(p.apps)) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(app) || !["ask", "auto", "off"].includes(e?.tasks)) return `app ${app}: tasks must be ask | auto | off`;
    if (!Array.isArray(e.projects ?? []) || (e.projects ?? []).some((x: any) => typeof x !== "string" || x.length > 64)) return `app ${app}: projects is a list of names`;
    if (e.until != null && !Number.isFinite(Number(e.until))) return `app ${app}: until is a time in ms or null`;
    if ((e.keys ?? []).some((k: any) => !APP_KEY_RE.test(String(k)))) return `app ${app}: keys are ed25519 public keys`;
    if (e.sessions != null && !["off", "read", "write"].includes(e.sessions)) return `app ${app}: sessions must be off | read | write`; // live-sessions: the owner's local agent sessions
  }
  if (p.dev != null && p.autorun != null) return "autorun replaces dev (the old name): send one of them";
  for (const f of ["autorun", "dev"]) if (p[f] != null) { const d = p[f]; // Run tasks without asking (client/payload.ts autorunOn): on, an optional end, the relay-held key; dev = its old name, read-only
    if (typeof d !== "object" || d.on !== true || (d.until != null && !Number.isFinite(Number(d.until))) || !Array.isArray(d.keys) || !d.keys.length || d.keys.length > 4 || d.keys.some((k: any) => !APP_KEY_RE.test(String(k))) || Object.keys(d).some(k => !["on", "until", "keys"].includes(k)))
      return `${f}: {on: true, until: ms | null, keys: [ed25519 keys]} (leave it out for off)`; }
  if (p.experimental != null) { const x = p.experimental; // Experimental (client/payload.ts experimentalOn): features only, no permission
    if (typeof x !== "object" || x.on !== true || Object.keys(x).some(k => !["on", "ci", "gh_status"].includes(k)) || ["ci", "gh_status"].some(k => x[k] != null && typeof x[k] !== "boolean"))
      return "experimental: {on: true, ci?: bool, gh_status?: bool} (leave it out for off)"; }
  if (!keys.includes(env.key)) return "signed by a key this account hasn't registered";
  try {
    const k = await crypto.subtle.importKey("spki", unb64u(env.key.slice(5)), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, k, unb64u(env.sig), te.encode(policyMsg(p))) ? null : "bad signature";
  } catch { return "bad owner key or signature"; }
}
// null when env is a Settings change for the Mac ({cmd, key, sig}) for `space`, recent, signed by one of `keys`, else why not
export async function checkCmd(env: any, keys: string[], space: string): Promise<string | null> {
  if (!env || typeof env !== "object" || typeof env.sig !== "string" || typeof env.key !== "string") return "envelope: {cmd, key, sig}";
  const e = cmdShape(env.cmd); if (e) return e; if (env.cmd.space !== space) return "for another workspace";
  if (Math.abs(Date.now() - env.cmd.at) > CMD_WINDOW_MS) return "too old: reload Settings and try again";
  if (!keys.includes(env.key)) return "signed by a key this account hasn't registered";
  try { const k = await crypto.subtle.importKey("spki", unb64u(env.key.slice(5)), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, k, unb64u(env.sig), te.encode(cmdMsg(env.cmd))) ? null : "bad signature"; } catch { return "bad owner key or signature"; }
}
export async function mintAppKey(): Promise<{ pub: string; priv: string }> {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" } as any, true, ["sign", "verify"]) as CryptoKeyPair;
  return { pub: "ed25519:" + b64u(await crypto.subtle.exportKey("raw", kp.publicKey) as ArrayBuffer), priv: b64u(await crypto.subtle.exportKey("pkcs8", kp.privateKey) as ArrayBuffer) };
}
export const kbHash = async (text: string) => (await sha256hex(String(text ?? "").slice(0, 1200))).slice(0, 32); // = client/sign.ts kbHash
// The signature client/sign.ts signCreate would make, over the task exactly as the server stores it (so it is what the runner re-hashes).
export async function signStored(t: any, key: { pub: string; priv: string }) {
  const kb = (t.kb_context ?? []).slice(0, 25).map((x: any) => [String(x.id), "", x.author ? String(x.author).slice(0, 200) : null]);
  for (let i = 0; i < kb.length; i++) kb[i][1] = await kbHash(t.kb_context[i].text); const list = kb.map((p: any[]) => p[2] ? p : p.slice(0, 2));
  const e: any = { v: 1, alg: "ed25519", key: key.pub, task: t.id, target: t.target, from: t.from, ts: Date.now(), nonce: b64u(crypto.getRandomValues(new Uint8Array(18))),
    hash: await sha256hex(canon(dispatchPayload(t, list.length ? list : undefined))), ...(list.length ? { kb: list } : {}), by: "relay" }; // by: informational (not signed)
  const pk = await crypto.subtle.importKey("pkcs8", unb64u(key.priv), { name: "Ed25519" } as any, false, ["sign"]);
  e.sig = b64u(await crypto.subtle.sign({ name: "Ed25519" } as any, pk, te.encode(dispatchMsg(e))));
  return e;
}
export { autoEntry, type PolicyEntry };
export { standingEntry, autorunOn, describeAutorun, experimentalOn, describeExperimental, migratePolicy } from "../client/payload.ts";
// The relay-held autorun key (Space meta appkey:*autorun; "*" can't start an app name): it signs the tasks of the owner's own apps while
// the owner-signed policy has "Run tasks without asking" on. Like an app key it adds nothing against a compromised Kitebook; the owner's
// signature bounds it. LEGACY_AUTORUN_KEY: where it was kept while the switch was called dev mode (read once, then copied: src/space.ts).
export const AUTORUN_KEY = "*autorun", LEGACY_AUTORUN_KEY = "*dev";
// The grant a Permissions-panel choice gives (verbs + folder globs); dispatch follows the Tasks setting. raw = undo back to what it had.
export function accessGrant(a: any, cur: { verbs: string[]; paths: string[] }, tasks: string | null): { verbs: string[]; paths: string[] } {
  let verbs = cur.verbs.filter(v => v !== "dispatch"), paths = cur.paths;
  if (a) {
    if (a.mode === "raw") { verbs = (a.verbs ?? []).filter((v: string) => v !== "dispatch"); paths = a.paths ?? []; }
    else if (a.mode === "read") { verbs = ["read"]; paths = ["**"]; }
    else if (a.mode === "shared") { verbs = ["read", "write"]; paths = ["**", "write:shared/**", "write:kb/**"]; } // the assistant preset (oauth.ts PRESETS): saves only to shared memory
    else if (a.mode === "full") { verbs = ["read", "write", "delete"]; paths = ["**"]; }
    else if (a.mode === "folders") {
      const fs = (a.folders ?? []).map((f: any) => String(f).trim().replace(/^(\.?\/)+/, "").replace(/\/?\*\*$/, "").replace(/\/+$/, "")).filter(Boolean);
      if (!fs.length || fs.length > 20 || fs.some((f: string) => !/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(f) || f.split("/").includes(".."))) throw new Error("folders: one to 20 folder paths such as kb or shared/notes");
      verbs = ["read", "write"]; paths = fs.map((f: string) => f + "/**");
    } else throw new Error("access: shared | folders | read | full");
  }
  const send = a?.mode === "raw" ? (a.verbs ?? []).includes("dispatch") && tasks !== "off" : tasks == null ? cur.verbs.includes("dispatch") : tasks !== "off";
  return { verbs: send ? [...verbs, "dispatch"] : verbs.length ? verbs : ["read"], paths: paths.length ? paths : ["**"] };
}
