// Signed dispatch: end-to-end task signatures, so approve=auto never rests on the server's word.
// Under approve=auto the runner used to trust the `from` name the server reports; a compromised Kitebook, a leaked admin token or any
// dispatch token could then make this machine run code. Now each dispatching peer can hold an Ed25519 key that never leaves it:
//   kitebook keygen                         (client) writes ~/.config/kitebook/signing-key.json (0600), prints the public key
//   bun runner.ts trust add <peer> <pk>  (owner, on the Mac) registers it in runner.json "trustedKeys" (protected, owner-only)
// task_create then carries `signature`: Ed25519 over "relay-dispatch:v1|task|target|from|ts|nonce|hash", where hash is approval-v2's
// canonical payload hash (client/approval.ts payloadOf, gate "dispatch", the agent/model the sender asked for, access left to the runner).
// The sender picks the task id (kitebook keeps it), so the signature binds the id too. Before auto-running, the runner re-hashes the task
// as the server has it now and checks: trusted key for that peer, id/target/from match, ts within 10 minutes, nonce never seen, signature valid.
// Anything else (unsigned, tampered, stale, replayed, unknown key) falls back to the human approval path; it's never auto-run.
import "./brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign as csign, verify as cverify, randomBytes, createHash } from "crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { payloadHash, b64u, unb64u } from "./approval.ts";
import { dispatchPayload, dispatchMsg } from "./payload.ts";
import { chainStepText, normStep } from "./chain.ts";

export const WINDOW_MS = 10 * 60_000, CHAIN_MS = 14 * 86400_000;
export { POLICY_WINDOW_MS as POLICY_WINDOW } from "./payload.ts";
const PFX = "ed25519:", SPKI = Buffer.from("302a300506032b6570032100", "hex"); // Ed25519 SPKI header; the raw key is the last 32 bytes
export const keyPath = () => process.env.KITEBOOK_SIGNING_KEY || join(homedir(), ".config", "kitebook", "signing-key.json");
const pubOf = (k: any) => PFX + b64u(createPublicKey(k).export({ format: "der", type: "spki" }).subarray(-32));
const pubKey = (s: string) => { if (!String(s).startsWith(PFX)) throw new Error(`public key must look like ${PFX}<base64url>`);
  const raw = unb64u(s.slice(PFX.length)); if (raw.length !== 32) throw new Error("Ed25519 public key must be 32 bytes"); return createPublicKey({ key: Buffer.concat([SPKI, raw]), format: "der", type: "spki" }); };
export const validPub = (s: string) => { try { pubKey(s); return true; } catch { return false; } };

// ---- keys (client side) ----
export function keygen(f = keyPath(), force = false): string {
  if (existsSync(f) && !force) throw new Error(`${f} exists (use --force to replace it; the old key's trust entries stop working)`);
  const { privateKey } = generateKeyPairSync("ed25519"), pub = pubOf(privateKey);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify({ alg: "ed25519", public: pub, private: privateKey.export({ format: "pem", type: "pkcs8" }), created: new Date().toISOString() }, null, 1), { mode: 0o600 }); chmodSync(f, 0o600);
  return pub;
}
export function loadKey(f = keyPath()) { const k = JSON.parse(readFileSync(f, "utf8")); return { pub: String(k.public), priv: createPrivateKey(String(k.private)) }; }

// ---- what gets signed ----
// The task as the server stores it, predicted from task_create args the same way src/space.ts task_create normalizes them
// (spec normalization, spec.goal as instructions, top-level scope feeding the spec, a follow-up inheriting project/agent/model).
// If a prediction ever drifts the hash differs and the task falls back to a human approval: a safe failure, never an auto-run.
const strs = (v: any) => (v == null ? [] : typeof v === "string" ? [v] : v).map((x: string) => String(x).trim());
function specOf(s: any) {
  if (s == null) return null; const b = s.budget ?? {};
  return { version: 2, goal: s.goal?.trim?.() ?? null, acceptance: strs(s.acceptance), scope: strs(s.scope), forbidden: strs(s.forbidden),
    budget: { minutes: b.minutes ?? undefined, max_files_changed: b.max_files_changed ?? undefined }, mode: s.mode ?? "execute" };
}
const txt = (v: any) => v == null ? null : String(v); // sqlite TEXT columns store numbers as text
export function predictTask(a: any, id: string, from: string, parent?: any) {
  const spec = specOf(a.spec), instructions = a.instructions == null || a.instructions === "" ? spec?.goal ?? null : String(a.instructions);
  if (spec && !spec.scope.length && Array.isArray(a.scope)) spec.scope = a.scope;
  // follow-up: project and agent come from the parent; its model only when the agent stays the same (a handoff to another agent
  // must not carry the old agent's model), exactly as space.ts task_create does
  // git-first: repo (credentials stripped) and base as the server keeps them; a repo URL maps to a runner project only the server/runner
  // know, so pass project with repo when signing (repo alone predicts project null: the task then safely asks a human)
  let project = a.project, agent = a.agent, model = a.model, kind = a.kind ?? null, verify = a.verify, ins = instructions, chain: any = null;
  let repo = typeof a.repo === "string" ? a.repo.trim().replace(/^(https?:\/\/)[^@\/]+@/, "$1") : a.repo ?? null;
  if (parent) { if (agent == null || agent === parent.agent) model ??= parent.model ?? undefined; project ??= parent.project; agent ??= parent.agent ?? undefined; repo ??= parent.repo ?? null; }
  if (a.chain != null && Array.isArray(a.chain)) { // step 1 is this task; the chain definition is signed with it so its children can inherit trust
    const steps = a.chain.map(normStep); chain = { goal: String(ins), steps, verify: verify ?? null };
    ins = chainStepText(chain.goal, steps, 0); kind = steps[0].kind; verify = steps[0].verify ?? verify;
    if (steps[0].agent) { agent = steps[0].agent; model = steps[0].model ?? undefined; }
  }
  return { id, from, title: txt(a.title), instructions: ins, acceptance: txt(a.acceptance), scope: a.scope ?? spec?.scope ?? [], verify: txt(verify),
    project: txt(project), agent: txt(agent), model: txt(model), kind: txt(kind), continue_from: txt(a.continue_from), spec, chain, repo: txt(repo), base: txt(a.base) };
}
// approval-v2's payload with gate "dispatch": the agent/model the sender asked for (null = the runner's pick), access is the runner's own setting
// Also kind (it steers the owner's per-kind agent prefs) and, for a chain's first step, the chain definition. kb_context itself is left
// out (the server stores it beside the task); instead the sender signs the list of KB entries it chose, [[id, kbHash(text)], ...]
// (signature.kb, folded into this hash when present), and the runner keeps only entries matching that list (keepSignedKb).
// No list (older signatures) = no KB: their hash is unchanged, so they stay valid and simply run without kitebook-picked notes.
export { dispatchPayload }; // client/payload.ts (pure: the server signs with the same payload for apps the owner lets run on their own)
// ---- signed KB context ----
// The server delivers each entry's text cut to KB_TEXT (src/kb.ts contextFor/contextByIds); the hash is over exactly that text.
export const KB_TEXT = 1200, KB_MAX = 25;
export const kbHash = (text: string) => createHash("sha256").update(String(text ?? "").slice(0, KB_TEXT)).digest("hex").slice(0, 32);
// [id, hash] or, since R8, [id, hash, author]: the author peer the sender saw for that note, signed so the server can't relabel it later
export type KbPair = [string, string] | [string, string, string];
const kbList = (v: any): v is KbPair[] => Array.isArray(v) && v.length <= KB_MAX && v.every(p => Array.isArray(p) && (p.length === 2 || (p.length === 3 && typeof p[2] === "string" && p[2].length <= 200)) && typeof p[0] === "string" && /^[0-9a-f]{32}$/.test(p[1]));
// Sender side: the same top-k the server would attach (title + goal, global + the task's project, minus the project's own context pack,
// which the claimer gets whole), fetched by the sender so it can sign them. kb_k 0 = none. Search errors mean "no KB", never unsigned.
// Provenance (R8): with `trusted` (a set of peer names), only notes whose author (the peer that committed them, src/kb.ts) is in it
// are signed; the rest go to `dropped` so the caller can say what was left out. Notes without an author (an older Kitebook) are untrusted.
// The CLI's default set is the sender itself + the target runner (its own kb.sync memory and learnings) + KITEBOOK_KB_TRUST.
export async function pickKb(call: (op: string, a?: any) => Promise<any>, a: any, parent?: any, o: { trusted?: Set<string> | null; dropped?: { id: string; author: string | null }[] } = {}): Promise<{ id: string; text: string; author?: string | null }[]> {
  const k = a.kb_k == null ? 5 : Math.min(Number(a.kb_k) || 0, KB_MAX); if (!(k > 0)) return [];
  const project = a.project ?? parent?.project ?? null, goal = a.spec?.goal ?? a.instructions ?? "";
  const scope = ["global", ...(project && project !== "home" && project !== "global" && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(project) ? [`project:${project}`] : [])];
  try { const r = await call("kb_search", { query: `${a.title ?? ""}\n${goal}`.slice(0, 2000), scope, k: Math.min(k + 5, 25) });
    const ok = (x: any) => { if (!o.trusted || (x.author && o.trusted.has(String(x.author)))) return true; o.dropped?.push({ id: String(x.id), author: x.author ?? null }); return false; };
    return (r.results ?? []).filter((x: any) => x.path !== (project ? `context/${project}.md` : null)).slice(0, k).filter(ok)
      .map((x: any) => ({ id: String(x.id), text: String(x.text).slice(0, KB_TEXT), ...(x.author ? { author: String(x.author) } : {}) }));
  } catch { return []; }
}
// Runner side, signed auto-run only: drop every kb_context entry whose id isn't in the signed list (injected) or whose text no longer
// hashes to the signed hash (altered), and, with `trusted` (runner.json trustedKbAuthors), every entry whose author isn't in it: the
// signed author when the list carries one, else the author the server reports; none = untrusted. A valid signature proves the sender
// sent the note, not who wrote it. Mutates t.kb_context; returns what was dropped (untrusted: true for author drops) for the audit.
export function keepSignedKb(t: any, signed: KbPair[] | undefined | null, trusted?: Set<string> | null): { id: string; why: string; untrusted?: boolean; author?: string | null }[] {
  const want = new Map((signed ?? []).map(p => [p[0], p])), dropped: { id: string; why: string; untrusted?: boolean; author?: string | null }[] = [], kept: any[] = [];
  for (const x of t.kb_context ?? []) { const p = want.get(String(x?.id)), au = p?.[2] ?? x?.author ?? null;
    if (p == null) dropped.push({ id: String(x?.id), why: signed ? "not in the signed KB list (injected)" : "the signature carries no KB list" });
    else if (kbHash(x.text) !== p[1]) dropped.push({ id: String(x.id), why: "text doesn't match its signed hash (altered)" });
    else if (trusted && !(au && trusted.has(String(au)))) dropped.push({ id: String(x.id), why: `author ${au ?? "unknown"} is not in trustedKbAuthors`, untrusted: true, author: au });
    else kept.push(x); }
  t.kb_context = kept.length ? kept : null; return dropped;
}
const msg = dispatchMsg;
export const newTaskId = () => "t_" + randomBytes(8).toString("hex");

// Adds id + signature to task_create args. `from` is the sender's own peer name (whoami), `parent` the continue_from task if any.
// `kb` (from pickKb): the KB entries to attach; their ids go to the server as kb_ids and [id, hash] pairs into the signature.
export function signCreate(a: any, o: { from: string; key: { pub: string; priv: any }; parent?: any; ts?: number; nonce?: string; id?: string; kb?: { id: string; text: string; author?: string | null }[] }) {
  const kb = o.kb ? o.kb.slice(0, KB_MAX).map(x => (x.author ? [String(x.id), kbHash(x.text), String(x.author).slice(0, 200)] : [String(x.id), kbHash(x.text)]) as KbPair) : undefined;
  const id = o.id ?? newTaskId(), e: any = { v: 1, alg: "ed25519", key: o.key.pub, task: id, target: String(a.target), from: o.from,
    ts: o.ts ?? Date.now(), nonce: o.nonce ?? b64u(randomBytes(18)), hash: payloadHash(dispatchPayload(predictTask(a, id, o.from, o.parent), kb)), ...(kb ? { kb } : {}) };
  e.sig = b64u(csign(null, Buffer.from(msg(e)), o.key.priv));
  return { ...a, ...(kb ? { kb_ids: kb.map(p => p[0]) } : {}), signature: e };
}

// ---- runner side ----
// Seen nonces, persisted so a restart doesn't reopen the window. Entries older than twice the window are pruned (the ts check covers them).
export class Nonces {
  constructor(private f: string) {}
  private all(): Record<string, number> { try { return JSON.parse(readFileSync(this.f, "utf8")); } catch { return {}; } }
  seen(n: string) { return n in this.all(); }
  has(k: string) { return k in this.all(); }
  hasPrefix(p: string) { return Object.keys(this.all()).some(k => k.startsWith(p)); }
  add(n: string, now = Date.now()) { this.put(n, now); }
  mark(k: string, now = Date.now()) { this.put(k, now); } // chain records (chain:<id>, chain:<id>:<step>): kept CHAIN_MS, a chain's steps can run for days
  private put(n: string, now: number) {
    const m = this.all(); for (const [k, t] of Object.entries(m)) if (now - t > (k.startsWith("chain:") || k.startsWith("p:") ? CHAIN_MS : 2 * WINDOW_MS)) delete m[k]; // p: = policy runs (24 h window)
    m[n] = now; mkdirSync(dirname(this.f), { recursive: true }); writeFileSync(this.f, JSON.stringify(m), { mode: 0o600 });
  }
}
// The signature on e (from a task's limits._sig) is valid for task t, by a key trusted for t.from. Checks id/target/from, ts window
// (unless skipWindow), the Ed25519 signature and the payload hash; not the nonce.
function checkSig(t: any, e: any, me: string, keys: Record<string, string[] | string> | undefined, now: number, skipWindow = false, windowMs = WINDOW_MS): "ok" | string {
  if (typeof e !== "object" || e.v !== 1 || e.alg !== "ed25519" || (e.kb != null && !kbList(e.kb))) return "unsupported signature format";
  const mine = ([] as string[]).concat(keys?.[t.from] ?? []);
  if (!mine.length) return `no trusted signing key for ${t.from} (bun runner.ts trust add <runner.json> ${t.from} <pubkey>)`;
  if (!mine.includes(e.key)) return `signed with a key that isn't trusted for ${t.from}`;
  if (e.task !== t.id || e.target !== me || e.from !== t.from) return "signature is for another task, target or sender";
  if (!skipWindow && !(Math.abs(now - Number(e.ts)) <= windowMs)) return `signature is outside its ${windowMs > WINDOW_MS ? "24-hour" : "10-minute"} window (stale or replayed)`;
  let ok = false; try { ok = cverify(null, Buffer.from(msg(e)), pubKey(e.key), Buffer.from(unb64u(e.sig))); } catch { ok = false; }
  if (!ok) return "bad signature";
  if (e.hash !== payloadHash(dispatchPayload(t, e.kb ?? undefined))) return "the task doesn't match what was signed (tampered)";
  return "ok";
}
// "ok", or why this task can't auto-run. keys = runner.json trustedKeys { peer: ["ed25519:..."] }.
// A verified chain parent is recorded (chain:<id>) so its children can inherit its trust (verifyChainChild).
// windowMs: the owner's standing permission (client/policy.ts) accepts a signature up to 24 h old, so a task queued while the Mac slept
// still runs on its own; its nonce is then kept 14 days (p:<nonce>), longer than that window.
export function verifyTask(t: any, me: string, keys: Record<string, string[] | string> | undefined, nonces: Nonces, now = Date.now(), windowMs = WINDOW_MS): "ok" | string {
  const e = t.signature ?? t.limits?._sig; if (!e) return "unsigned";
  if (t.parent_id && e.task === t.parent_id) return "unsigned"; // a chain child carries its parent's signature (limits copied): verifyChainChild decides
  const v = checkSig(t, e, me, keys, now, false, windowMs); if (v !== "ok") return v;
  if (!e.nonce || nonces.seen(e.nonce) || nonces.seen(`p:${e.nonce}`)) return "nonce already used (replay)";
  if (windowMs > WINDOW_MS) nonces.mark(`p:${e.nonce}`, now); else nonces.add(String(e.nonce), now); if (t.chain?.steps?.length > 1) nonces.mark(`chain:${t.id}`, now); return "ok";
}
// A chain child (step n > 1) has no signature of its own: the server creates it when the previous step succeeds. It inherits trust
// when all of these hold, else it asks a human: this runner verified the parent's signature itself when the parent ran (chain:<id>
// record), the parent's signature still covers the parent as the server has it now (chain definition included), the child is exactly
// step n of that signed chain (instructions, agent, model, kind, verify, project, scope, sender), it follows up on step n-1 of the same
// chain, and no other task already ran as step n (one per step, recorded locally, so the server can't mint extra copies).
export function verifyChainChild(t: any, root: any, prev: any, me: string, keys: Record<string, string[] | string> | undefined, nonces: Nonces, now = Date.now()): "ok" | string {
  const n = Number(t.chain_step), e = root?.limits?._sig;
  if (!root || root.id !== t.parent_id || !Number.isInteger(n) || n < 1) return "unsigned";
  if (!e) return "unsigned"; // an unsigned chain: its children are as unsigned as it (without requireSignedAuto they run as before)
  if (!nonces.has(`chain:${root.id}`)) return "this runner never verified the chain's signed parent";
  const v = checkSig(root, e, me, keys, now, true); if (v !== "ok") return `chain parent: ${v}`;
  const m = chainStepMismatch(t, root, prev, "signed"); if (m) return m;
  if (nonces.has(`chain:${root.id}:${n}`)) return `chain step ${n + 1} already ran (replay)`;
  nonces.mark(`chain:${root.id}:${n}`, now); return "ok";
}
// null when child t is exactly step n of root's chain definition (root.chain = the definition, as task_get's chain_def) and follows
// step n-1; else why not. Shared by signed chains (above) and approved unsigned chains (below).
export function chainStepMismatch(t: any, root: any, prev: any, what = "signed"): string | null {
  const n = Number(t.chain_step), steps = (root.chain?.steps ?? []).map(normStep), s = steps[n]; if (!s) return `not a step of the ${what} chain`;
  const want = { from: root.from, title: `${s.title ?? root.title} [step ${n + 1}/${steps.length}: ${s.kind}]`, instructions: chainStepText(root.chain.goal, steps, n),
    project: root.project ?? null, scope: root.scope ?? [], verify: s.verify ?? root.chain.verify ?? null, agent: s.agent, model: s.agent ? s.model : null, kind: s.kind, acceptance: null, spec: null, repo: null, base: null, change: null }; // chainNext sets no git-first fields on children
  for (const [k, w] of Object.entries(want)) if (JSON.stringify(t[k] ?? null) !== JSON.stringify(w ?? null)) return `chain step ${n + 1} doesn't match the ${what} chain (${k})`;
  if (!prev || prev.id !== t.continue_from || (n === 1 ? prev.id !== root.id : prev.parent_id !== root.id || Number(prev.chain_step) !== n - 1)) return `chain step ${n + 1} doesn't follow step ${n}`;
  return null;
}

// ---- unsigned chains: one human approval per chain definition ----
// Approving step 1 of an unsigned chain approves its definition: the hash below rides in step 1's approval payload, and once the
// owner says yes this runner records it locally (chain:ok:<root>:<hash>). A later step (made by the server) then runs without asking
// only if the root as the server has it NOW still hashes the same and the step is exactly step n of it, following step n-1, once.
// Any change (definition, project, scope, title, sender, a step's text/agent/model/verify) asks again. Signed chains don't use this.
export const chainDefHash = (root: any) => payloadHash({ v: 1, gate: "chain", root: root.id, from: root.from ?? null, target: root.target ?? null, project: root.project ?? null,
  scope: root.scope ?? [], title: root.title ?? null, chain: { goal: String(root.chain?.goal ?? ""), steps: (root.chain?.steps ?? []).map(normStep), verify: root.chain?.verify ?? null } });
export const isUnsignedChainRoot = (t: any) => !t.parent_id && Array.isArray(t.chain?.steps) && t.chain.steps.length > 1 && !t.limits?._sig;
export function approveChain(root: any, nonces: Nonces, now = Date.now()) { const h = chainDefHash(root); nonces.mark(`chain:ok:${root.id}:${h}`, now); return h; }
// "ok" (run without asking), null (no approved definition for this chain: ask as usual), or why the owner is asked again.
export function checkApprovedChain(t: any, root: any, prev: any, nonces: Nonces, now = Date.now()): "ok" | null | string {
  const n = Number(t.chain_step);
  if (!root || root.id !== t.parent_id || !Number.isInteger(n) || n < 1 || root.limits?._sig) return null;
  if (!nonces.has(`chain:ok:${root.id}:${chainDefHash(root)}`)) return nonces.hasPrefix(`chain:ok:${root.id}:`) ? "the chain changed since you approved it" : null;
  const m = chainStepMismatch(t, root, prev, "approved"); if (m) return m;
  if (nonces.has(`chain:${root.id}:${n}`)) return `chain step ${n + 1} already ran (replay)`;
  nonces.mark(`chain:${root.id}:${n}`, now); return "ok";
}

// ---- owner CLI: bun runner.ts trust add|remove|list [runner.json] <peer> [pubkey] ----
export function trustCli(argv: string[], stamp: (f: string) => void): number {
  const [cmd, ...rest] = argv, f = rest[0]?.endsWith(".json") ? rest.shift()! : "runner.json", [peer, pk] = rest;
  const c = JSON.parse(readFileSync(f, "utf8")); c.trustedKeys ??= {};
  const save = () => { writeFileSync(f, JSON.stringify(c, null, 2), { mode: 0o600 }); chmodSync(f, 0o600); stamp(f); };
  if (cmd === "list") { console.log(JSON.stringify({ requireSignedAuto: c.requireSignedAuto ?? null, trustedKeys: c.trustedKeys }, null, 2)); return 0; }
  if (cmd === "add" && peer && pk) {
    if (!validPub(pk)) { console.error(`not an Ed25519 public key: ${pk} (want ${PFX}<base64url>, from: kitebook keygen)`); return 2; }
    c.trustedKeys[peer] = [...new Set([...[].concat(c.trustedKeys[peer] ?? []), pk])]; save();
    console.log(`trusted ${peer}: ${pk.slice(0, 20)}… (${c.trustedKeys[peer].length} key(s)). Signed tasks from ${peer} can now auto-run${c.approve === "auto" ? "" : " once approve is auto"}.`); return 0;
  }
  if (cmd === "remove" && peer) {
    c.trustedKeys[peer] = [].concat(c.trustedKeys[peer] ?? []).filter((k: string) => pk && k !== pk); if (!c.trustedKeys[peer].length) delete c.trustedKeys[peer]; save();
    console.log(`${peer}: ${c.trustedKeys[peer]?.length ?? 0} trusted key(s) left`); return 0;
  }
  console.error("usage: trust add [runner.json] <sender name> <ed25519:pubkey> | trust remove [runner.json] <sender name> [pubkey] | trust list [runner.json]"); return 2;
}
