// MCP Events extension (io.modelcontextprotocol/events), draft: SEP-3415 / the Triggers & Events WG design sketch.
// Event types are views over the space's existing event log (the `events` table in space.ts), so every mode replays from
// the same durable history: poll (events/poll), push (events/stream, SSE), webhook (events/subscribe, Standard Webhooks).
// This file holds the transport-independent parts: descriptors, argument validation, matching, cursors, signing, SSRF.
import { globMatch, sha256 } from "./ops.ts";

export const EXT = "io.modelcontextprotocol/events";
export const SUB_META = "io.modelcontextprotocol/subscriptionId";
// SEP-3415 codes (provisional until the SEP is accepted)
export const CODES = { InvalidParams: -32602, NotFound: -32023, Forbidden: -32024, ResourceExhausted: -32025, Unsupported: -32026, CallbackEndpointError: -32027, HeaderMismatch: -32020 } as const;
export class EventsError extends Error { constructor(public code: number, message: string, public data?: any) { super(message); } }
export const evErr = (k: keyof typeof CODES, data?: any) => new EventsError(CODES[k], k, data);

export const STATES = ["queued", "claimed", "awaiting_approval", "running", "needs_input", "succeeded", "failed", "rejected", "cancelled"];
export const TERMINAL = ["succeeded", "failed", "rejected", "cancelled"];
export type Mode = "poll" | "push" | "webhook";
const MODES: Mode[] = ["poll", "push", "webhook"];

const space = { type: "string", description: "space id (optional if your token has one space)" };
const taskFilter = {
  type: "object", additionalProperties: false,
  properties: { space, task_id: { type: "string", description: "only this task" }, target: { type: "string", description: "only tasks sent to this peer" },
    state: { type: "string", enum: STATES, description: "only when the task enters this state" } },
};
const taskPayload = (extra: Record<string, any> = {}) => ({
  type: "object", required: ["task_id", "state"],
  properties: { task_id: { type: "string" }, title: { type: "string" }, state: { type: "string", enum: STATES }, from: { type: "string" }, target: { type: "string" },
    actor: { type: "string", description: "peer that caused the change" }, ...extra },
});

export type EvType = { name: string; description: string; delivery: Mode[]; inputSchema: any; payloadSchema: any; verbs: string[] /* any of; [] = any member */ };
export const EVENT_TYPES: EvType[] = [
  { name: "task.updated", description: "A task you sent or received changed state (queued, claimed, awaiting_approval, running, needs_input, succeeded, failed, rejected, cancelled) or got a thread message or a steering note (change steer).",
    delivery: MODES, verbs: [], inputSchema: taskFilter,
    payloadSchema: taskPayload({ change: { type: "string", enum: ["state", "message", "steer"] }, message: { type: "string", description: "progress or thread text, truncated to 500 chars" },
      question: { type: "string", description: "state needs_input: the target's question (answer with task_answer); state running after an answer: the question answered" },
      answer: { type: "string", description: "state running after task_answer: the answer, truncated to 500 chars" } }) },
  { name: "task.completed", description: "A task you sent or received finished: succeeded, failed, rejected or cancelled.",
    delivery: MODES, verbs: [], inputSchema: { ...taskFilter, properties: { ...taskFilter.properties, state: { type: "string", enum: TERMINAL, description: "only this outcome" } } },
    payloadSchema: taskPayload({ summary: { type: "string", description: "result summary, truncated to 500 chars; fetch the full record with task_get" },
      headline: { type: "string", description: "the result headline, one fact per line: outcome, what changed, tests, branch, time the agent worked, the one next action (task_get.headline has it as an object)" } }) },
  { name: "file.changed", description: "A file you can read was written or deleted in the shared space.",
    delivery: MODES, verbs: ["read"],
    inputSchema: { type: "object", additionalProperties: false, properties: { space, path_glob: { type: "string", default: "**", description: "glob over paths, e.g. shared/**/*.md" },
      exclude_self: { type: "boolean", default: false, description: "skip changes you made yourself" } } },
    payloadSchema: { type: "object", required: ["path", "change"], properties: { path: { type: "string" }, change: { type: "string", enum: ["written", "deleted"] },
      sha: { type: ["string", "null"] }, commit: { type: "string" }, actor: { type: "string" },
      paths: { type: "array", description: "webhook only: when one commit changed several matching files, they come as ONE delivery; path/change/sha are the first, paths lists all", items: { type: "object" } } } } },
  { name: "inbox.task_assigned", description: "A new task landed in a peer's inbox. Defaults to your own inbox; for another peer you only see tasks you sent it.",
    delivery: MODES, verbs: [],
    inputSchema: { type: "object", additionalProperties: false, properties: { space, peer: { type: "string", description: "whose inbox (default: you)" } } },
    payloadSchema: { type: "object", required: ["task_id", "target"], properties: { task_id: { type: "string" }, title: { type: "string" }, from: { type: "string" },
      target: { type: "string" }, project: { type: ["string", "null"] } } } },
  { name: "inbox.message", description: "A peer sent you a short message with the notify tool (runners and agents use it to wake you).",
    delivery: MODES, verbs: [],
    inputSchema: { type: "object", additionalProperties: false, properties: { space, from: { type: "string", description: "only messages from this peer" } } },
    payloadSchema: { type: "object", required: ["from", "to", "message"], properties: { from: { type: "string" }, to: { type: "string" }, message: { type: "string" }, task_id: { type: ["string", "null"] } } } },
];
export const typeOf = (name: any) => EVENT_TYPES.find(t => t.name === name);
export const descriptors = () => EVENT_TYPES.map(({ verbs, ...d }) => ({ ...d, _meta: { "relay/requiredVerbs": verbs } }));

// Minimal validator for the flat schemas above: known keys, primitive types, enums. Returns args with defaults applied.
export function validateArgs(t: EvType, args: any): Record<string, any> {
  if (args == null) args = {};
  if (typeof args !== "object" || Array.isArray(args)) throw evErr("InvalidParams", { reason: "arguments must be an object" });
  const props = t.inputSchema.properties, out: Record<string, any> = {};
  for (const [k, v] of Object.entries(args)) {
    const s = props[k]; if (!s) throw evErr("InvalidParams", { reason: `unknown argument ${k}` });
    if (v === undefined || v === null) continue;
    if (typeof v !== (s.type === "boolean" ? "boolean" : "string")) throw evErr("InvalidParams", { reason: `${k} must be a ${s.type}` });
    if (s.enum && !s.enum.includes(v)) throw evErr("InvalidParams", { reason: `${k} must be one of ${s.enum.join(", ")}` });
    out[k] = v;
  }
  return out;
}

// Canonical JSON (sorted keys) for subscription keys: arguments compare by canonical-JSON equality.
export const canon = (v: any): string => Array.isArray(v) ? `[${v.map(canon).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ":" + canon(v[k])).join(",")}}` : JSON.stringify(v ?? null);

// Opaque cursor = position in the space's event log. Bound to the space so one space's cursor can't be replayed against another.
const b64u = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => atob(s.replace(/-/g, "+").replace(/_/g, "/"));
export const encCursor = (spaceId: string, seq: number) => "rc1." + b64u(`${spaceId}:${seq}`);
export function decCursor(spaceId: string, c: any): number | null {
  if (c === undefined || c === null) return null;
  let m: RegExpMatchArray | null = null;
  try { if (typeof c === "string" && c.startsWith("rc1.")) m = unb64u(c.slice(4)).match(/^(.*):(\d+)$/); } catch {}
  if (!m || m[1] !== spaceId) throw evErr("InvalidParams", { reason: "cursor is not valid for this space" });
  return Number(m[2]);
}

// A raw row of the space event log, normalized.
export type Raw = { seq: number; type: string; path?: string | null; task?: string | null; actor?: string | null; data: any; at: string };
export type TaskInfo = { title: string; from: string; target: string; project: string | null } | null;
const cut = (s: any, n = 500) => typeof s === "string" ? (s.length > n ? s.slice(0, n) + "…" : s) : undefined;

// Map one log row to the payload for event type `t` under `args`, or null when it doesn't match. Visibility is checked by the caller.
export function payloadFor(t: EvType, args: Record<string, any>, ev: Raw, me: string, task: (id: string) => TaskInfo): any | null {
  if (t.name === "file.changed") {
    if (ev.type !== "file.written" && ev.type !== "file.deleted") return null;
    if (!ev.path || !globMatch(args.path_glob ?? "**", ev.path)) return null;
    if (args.exclude_self && ev.actor === me) return null;
    return { path: ev.path, change: ev.type === "file.written" ? "written" : "deleted", sha: ev.data?.sha ?? null, commit: ev.data?.commit, actor: ev.actor ?? undefined };
  }
  if (t.name === "inbox.message") { // notify: addressed to one peer
    if (ev.type !== "peer.notify" || ev.data?.to !== me || (args.from && args.from !== ev.actor)) return null;
    return { from: ev.actor ?? "", to: me, message: String(ev.data?.message ?? ""), task_id: ev.data?.task ?? null };
  }
  if (!ev.task || !ev.type.startsWith("task.")) return null;
  const kind = ev.type.slice(5), info = task(ev.task); if (!info) return null;
  if (t.name === "inbox.task_assigned") {
    if (kind !== "queued" || info.target !== (args.peer ?? me)) return null;
    return { task_id: ev.task, title: info.title, from: info.from, target: info.target, project: info.project };
  }
  if (args.task_id && args.task_id !== ev.task) return null;
  if (args.target && args.target !== info.target) return null;
  const base = { task_id: ev.task, title: info.title, from: info.from, target: info.target, actor: ev.actor ?? undefined };
  if (t.name === "task.completed") {
    if (!TERMINAL.includes(kind) || (args.state && args.state !== kind)) return null;
    return { ...base, state: kind, summary: cut(ev.data?.summary ?? ev.data?.reason), ...(ev.data?.headline ? { headline: String(ev.data.headline).slice(0, 1500) } : {}) };
  }
  if (t.name === "task.updated") {
    if (kind === "message") return args.state ? null : { ...base, state: undefined, change: "message", message: cut(ev.data?.message) };
    if (kind === "steered") return args.state ? null : { ...base, state: undefined, change: "steer", message: cut(ev.data?.message) }; // task_steer: a note for the running agent
    if (!STATES.includes(kind) || (args.state && args.state !== kind)) return null;
    return { ...base, state: kind, change: "state", message: cut(ev.data?.message ?? ev.data?.summary ?? ev.data?.note),
      ...(ev.data?.question ? { question: cut(ev.data.question) } : {}), ...(ev.data?.answer ? { answer: cut(ev.data.answer) } : {}) };
  }
  return null;
}

// ---------- Standard Webhooks ----------
export function secretBytes(whsec: any): Uint8Array {
  if (typeof whsec !== "string" || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(whsec)) throw evErr("InvalidParams", { reason: "delivery.secret must be whsec_ followed by base64 of 24-64 random bytes" });
  let raw: string; try { raw = atob(whsec.slice(6)); } catch { throw evErr("InvalidParams", { reason: "delivery.secret is not valid base64" }); }
  if (raw.length < 24 || raw.length > 64) throw evErr("InvalidParams", { reason: "delivery.secret must decode to 24-64 bytes" });
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}
export async function signV1(whsec: string, id: string, ts: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", secretBytes(whsec), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${body}`)));
  return "v1," + btoa(String.fromCharCode(...mac));
}
export const subId = async (principal: string, url: string, name: string, args: any) => "sub_" + (await sha256(canon([principal, url, name, args]))).slice(0, 16);

// ---------- SSRF guards ----------
// Static checks at subscribe time; resolved-address checks again before every delivery (DNS rebinding).
function v4(ip: string): number[] | null { const p = ip.split("."); if (p.length !== 4 || p.some(x => !/^\d{1,3}$/.test(x) || +x > 255)) return null; return p.map(Number); }
export function privateIp(ip: string): boolean {
  ip = ip.replace(/^\[|\]$/g, "").toLowerCase();
  const a = v4(ip);
  if (a) {
    const [x, y] = a;
    return x === 0 || x === 10 || x === 127 || (x === 100 && y >= 64 && y <= 127) || (x === 169 && y === 254) || (x === 172 && y >= 16 && y <= 31)
      || (x === 192 && y === 168) || (x === 192 && y === 0) || (x === 198 && (y === 18 || y === 19)) || x >= 224 || (x === 192 && y === 88 && a[2] === 99)
      || (x === 198 && y === 51 && a[2] === 100) || (x === 203 && y === 0 && a[2] === 113) || (x === 192 && y === 0 && a[2] === 2);
  }
  if (ip.includes(":")) {
    if (ip === "::" || ip === "::1") return true;
    const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); if (mapped) return privateIp(mapped[1]);
    return /^(fc|fd|fe[89ab]|ff|2001:db8:|64:ff9b:|100::|2001::|2001:0:|2002:)/.test(ip) || ip.startsWith("::ffff:");
  }
  return false;
}
const isIpLiteral = (h: string) => !!v4(h) || h.includes(":");
const loopbackHost = (h: string) => h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
export type CallbackPolicy = { allowLoopback: boolean };
export function checkCallbackUrl(raw: any, pol: CallbackPolicy): URL {
  let u: URL; try { u = new URL(String(raw)); } catch { throw evErr("InvalidParams", { reason: "delivery.url is not a valid URL" }); }
  const host = u.hostname.toLowerCase(), loop = pol.allowLoopback && loopbackHost(host);
  if (u.protocol !== "https:" && !(loop && u.protocol === "http:")) throw evErr("InvalidParams", { reason: "delivery.url must be https" });
  if (u.username || u.password) throw evErr("InvalidParams", { reason: "delivery.url must not carry credentials" });
  if (loop) return u;
  if (loopbackHost(host) || /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/.test(host) || !host.includes(".") && !host.includes(":"))
    throw evErr("InvalidParams", { reason: "delivery.url must be a public host" });
  if (isIpLiteral(host) && privateIp(host)) throw evErr("InvalidParams", { reason: "delivery.url resolves to a non-public address" });
  return u;
}
// Delivery-time check: resolve via DNS-over-HTTPS and refuse if any address is non-public. Cached per host for <=60s.
const dnsCache = new Map<string, { ok: boolean; until: number }>();
export async function resolvesPublic(u: URL, pol: CallbackPolicy): Promise<boolean> {
  const host = u.hostname.toLowerCase();
  if (pol.allowLoopback && loopbackHost(host)) return true;
  if (isIpLiteral(host)) return !privateIp(host);
  const hit = dnsCache.get(host); if (hit && hit.until > Date.now()) return hit.ok;
  let ok = false, ttl = 60;
  try {
    const addrs: string[] = [];
    for (const type of ["A", "AAAA"]) {
      const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(3000) });
      const j: any = await r.json();
      for (const a of j.Answer ?? []) if (a.type === 1 || a.type === 28) { addrs.push(a.data); ttl = Math.min(ttl, a.TTL ?? 60); }
    }
    ok = addrs.length > 0 && addrs.every(a => !privateIp(a));
  } catch { ok = false; ttl = 5; }
  dnsCache.set(host, { ok, until: Date.now() + Math.max(ttl, 1) * 1000 });
  return ok;
}
// lastError categories (never raw endpoint responses)
export function category(status: number | null, e?: any): string {
  if (status === null) { const m = String(e?.name ?? "") + String(e?.message ?? e ?? ""); return /timeout|abort/i.test(m) ? "timeout" : /tls|ssl|certificate/i.test(m) ? "tls_error" : "connection_refused"; }
  return status >= 500 ? "http_5xx" : "http_4xx";
}
