// Read-only model catalogs. A CLI catalog is evidence of discovery, never proof of account entitlement.
import { Rpc } from "./live-codex.ts";
import * as PL from "./platform.ts";
import { redact } from "./redact.ts";
export type ModelEntry = { id: string; source: "native" | "configured" | "fallback"; default?: boolean };
export type Catalog = { agent: string; source: string; models: ModelEntry[]; authoritative: boolean; checked_at: string | null; attempted_at: string; expires_at: string | null; stale: boolean; availability: "unknown"; error?: string; truncated?: boolean };
export type ModelSpec = { agent: string; command?: string[]; configured?: string[]; extra?: string[]; fallback?: string[]; env: Record<string,string>; cwd: string; codex?: boolean; restrict?: boolean };
const valid = (s: unknown): s is string => typeof s === "string" && redact(s) === s && /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,199}$/.test(s);
export function parseModels(text: string) {
  const out: string[] = [];
  for (const line of text.split("\n")) { const c = line.trim().split(/\s+/); if (!c[0] || /:$/.test(c[0]) || /^(provider|model|name|id)$/i.test(c[0])) continue;
    const id = c.length === 1 ? c[0] : /^[\w.-]+$/.test(c[0]) && valid(c[1]) && !/^\d/.test(c[1]) ? `${c[0]}/${c[1]}` : ""; if (valid(id)) out.push(id); }
  return [...new Set(out)].slice(0, 1000);
}
async function readBounded(stream: ReadableStream<Uint8Array>, stop: () => void) { let text = "", n = 0; const reader = stream.getReader(), d = new TextDecoder();
  try { for (;;) { const r = await reader.read(); if (r.done) break; n += r.value.length; if (n > 1024 * 1024) { stop(); throw new Error("model catalog exceeded 1 MB"); } text += d.decode(r.value, { stream: true }); } return text + d.decode(); } finally { reader.releaseLock(); } }
export async function nativeModels(s: ModelSpec): Promise<{ ids: string[]; defaults?: string[]; truncated?: boolean }> {
  if (s.codex && !s.command) {
    const rpc = new Rpc(["codex", "app-server"], s.cwd, s.env), end = Date.now() + 12_000;
    const request = (method: string, args: any) => rpc.request<any>(method, args, Math.max(1, Math.min(5000, end - Date.now())));
    try { await request("initialize", { clientInfo: { name: "kitebook-model-discovery", title: "Kitebook", version: "1" }, capabilities: { experimentalApi: false } }); rpc.notify("initialized");
      const ids: string[] = [], defaults: string[] = [], seen = new Set<string>(); let cursor: string | null = null;
      for (let page = 0; page < 10; page++) { if (Date.now() >= end) throw new Error("model discovery timed out");
        const r = await request("model/list", { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) }); if (!Array.isArray(r.data)) throw new Error("invalid model catalog");
        for (const m of r.data) { const id = m.model ?? m.id; if (!m.hidden && valid(id)) { ids.push(id); if (m.isDefault === true) defaults.push(id); } }
        cursor = r.nextCursor ?? null; if (!cursor) return { ids: [...new Set(ids)].slice(0, 1000), defaults, truncated: ids.length > 1000 };
        if (typeof cursor !== "string" || seen.has(cursor)) throw new Error("invalid model catalog cursor"); seen.add(cursor);
      } throw new Error("model catalog pagination limit exceeded");
    } finally { rpc.close(); }
  }
  if (!s.command?.length) throw new Error("no read-only native model discovery adapter");
  const p = PL.spawn(s.command, { cwd: s.cwd, env: s.env, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true }); let timed = false;
  const stop = () => { if (process.platform === "win32") PL.killTreeWin(p.pid); else try { process.kill(-p.pid, "SIGKILL"); } catch {} try { p.kill("SIGKILL"); } catch {} }, timer = setTimeout(() => { timed = true; stop(); }, 10_000);
  try { const [out, err, code] = await Promise.all([readBounded(p.stdout, stop), readBounded(p.stderr!, stop), p.exited]);
    if (timed || code !== 0) throw new Error(timed ? "model discovery timed out" : "model list command failed"); return { ids: parseModels(out + "\n" + err) };
  } finally { clearTimeout(timer); stop(); }
}
export class ModelDiscovery {
  private cache = new Map<string, { key: string; at: number; value: Catalog }>(); private busy = new Map<string, Promise<Catalog>>();
  constructor(private discover = nativeModels, private clock = Date.now) {}
  async get(s: ModelSpec, refresh = false): Promise<Catalog> {
    const key = JSON.stringify([s.command, s.configured, s.extra, s.fallback, s.codex, s.restrict, s.cwd, s.env.PATH, s.env.HOME, s.env.CODEX_HOME]), cached = this.cache.get(s.agent), now = this.clock();
    if (cached?.key === key && now - cached.at < (refresh ? 5000 : 900_000)) return { ...cached.value, stale: cached.value.stale || !cached.value.checked_at || now >= Date.parse(cached.value.expires_at!) };
    const busyKey = s.agent + key, prior = this.busy.get(busyKey); if (prior) return prior;
    const run = (async () => { const at = new Date(this.clock()).toISOString(); let entries: ModelEntry[] = [], source = "unknown", error: string | undefined, truncated = false, checked: string | null = null;
      if (s.configured !== undefined) { source = "configured"; checked = at; entries = s.configured.filter(valid).slice(0,1000).map(id => ({ id, source: "configured" })); }
      else try { const r = await this.discover(s); entries = r.ids.filter(valid).slice(0,1000).map(id => ({ id, source: "native", ...(r.defaults?.includes(id) ? { default: true } : {}) })); source = "native"; checked = at; truncated = !!r.truncated; }
      catch (e: any) { error = redact(String(e.message ?? e)).slice(0, 300); if (cached?.key === key && cached.value.source === "native") { entries = cached.value.models; source = "native"; checked = cached.value.checked_at; }
        else { entries = (s.fallback ?? []).filter(valid).map(id => ({ id, source: "fallback" })); source = entries.length ? "fallback" : "unknown"; } }
      for (const id of (s.extra ?? []).filter(valid)) if (!entries.some(m => m.id === id)) entries.push({ id, source: "configured" });
      const expires = checked ? new Date(Date.parse(checked) + 900_000).toISOString() : null;
      const value: Catalog = { agent: s.agent, source, models: entries.slice(0,1000), authoritative: s.configured !== undefined || (!!s.restrict && source === "native" && !error), checked_at: checked, attempted_at: at, expires_at: expires, stale: !!error || !checked, availability: "unknown", ...(error ? { error } : {}), ...(truncated ? { truncated } : {}) };
      this.cache.set(s.agent, { key, at: this.clock(), value }); return value; })();
    this.busy.set(busyKey, run); try { return await run; } finally { this.busy.delete(busyKey); }
  }
}
