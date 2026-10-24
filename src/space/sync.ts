// Durable file synchronization. Notifications are hints; recovery reads the commit journal, never the pruned event feed.
import { RelayError, sha256, type Peer } from "../ops.ts";
import { normPath } from "./util.ts";
import type { Space, Op } from "../space.ts";

export const SYNC_SCHEMA = `
create table if not exists sync_replicas(peer text, replica text, path text, version integer, updated text, primary key(peer,replica));
create table if not exists sync_receipts(peer text, id text, fingerprint text, result text, primary key(peer,id));`;
type Token = { v: 1; epoch: string; space: string; peer: string; scope: string; prefix: string; mode: "snapshot" | "delta" | "checkpoint"; until: number; from: number; seq: number; path: string };
const enc = (v: Uint8Array) => btoa(String.fromCharCode(...v)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const dec = (v: string) => Uint8Array.from(atob(v.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
export function syncEpoch(sp: any) {
  sp.sql.exec("insert or ignore into meta values('sync_epoch',?)", crypto.randomUUID());
  return String(sp.sql.exec("select v from meta where k='sync_epoch'").one().v);
}
async function key(epoch: string) { return crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", new TextEncoder().encode(epoch)), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]); }
// A continuation may pass denied paths inside the requested folder. Authenticate AND encrypt it: a signature alone leaks names.
async function pack(t: Token) {
  const { epoch, ...publicToken } = t, iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(epoch), new TextEncoder().encode(JSON.stringify(publicToken)));
  return enc(iv) + "." + enc(new Uint8Array(encrypted));
}
async function unpack(raw: any, epoch: string): Promise<Token | null> {
  try { if (typeof raw !== "string" || raw.length > 16384) return null;
    const [nonce, body, extra] = raw.split("."); if (!nonce || !body || extra) return null;
    const iv = dec(nonce); if (iv.length !== 12) return null;
    const bytes = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await key(epoch), dec(body));
    const t = JSON.parse(new TextDecoder().decode(bytes)); return t.v === 1 ? { ...t, epoch } : null;
  } catch { return null; }
}
function prefixOf(a: any) { const p = normPath(a.path ?? "shared"); if (!/^(shared|kb|context)(\/|$)/.test(p)) throw new RelayError(400, "sync path must be under shared/, kb/ or context/ (durable files)"); return p; }
const under = (p: string, prefix: string) => p === prefix || p.startsWith(prefix + "/");
const capsOf = (m: any) => JSON.stringify([m.verbs.slice().sort(), m.paths.slice().sort()]);
async function identity(sp: any, peer: Peer) { const m = sp.need(peer, "read"); const caps = capsOf(m); return { epoch: syncEpoch(sp), scope: await sha256(caps), m, caps }; }
function matches(t: Token, sp: any, peer: Peer, id: any) { return t.space === sp.spaceId && t.peer === peer.id && t.scope === id.scope && t.until <= sp.headSeq(); }

export function syncOps(this: Space): Record<string, Op> {
  return {
    sync: async (peer, a) => {
      let id = await identity(this, peer), t = a.cursor ? await unpack(a.cursor, id.epoch) : null;
      // Recheck after asynchronous crypto: a grant may have changed while hashing/verifying.
      const current = await identity(this, peer); if (current.scope !== id.scope) return { reset_required: true, reason: "permissions_changed" }; id = current;
      if (a.cursor && (!t || !matches(t, this, peer, id))) return { reset_required: true, reason: "invalid_checkpoint" };
      if (t && a.path !== undefined && prefixOf(a) !== t.prefix) return { reset_required: true, reason: "path_changed" };
      if (!t) t = { v: 1, epoch: id.epoch, space: this.spaceId, peer: peer.id, scope: id.scope, prefix: prefixOf(a), mode: "snapshot", until: this.headSeq(), from: 0, seq: 0, path: "" };
      else if (t.mode === "checkpoint") t = { ...t, mode: "delta", from: t.until, until: this.headSeq(), seq: t.until, path: "" };
      const limit = Math.min(500, Math.max(1, Math.floor(Number(a.limit) || 200)));
      // Scan bounded pages before permission filtering. Cursor includes path within a commit, so a wide batch cannot skip entries.
      const rows = (t.mode === "snapshot"
        ? this.sql.exec(`select c.path,c.sha,b.size,b.enc,c.seq from changes c join (select path,max(seq) seq from changes where seq<=? and (path=? or (path>=? and path<?)) group by path) l on c.path=l.path and c.seq=l.seq left join blobs b on b.sha=c.sha where c.sha is not null and c.path>? order by c.path limit ?`, t.until, t.prefix, t.prefix + "/", t.prefix + "0", t.path, limit + 1)
        : this.sql.exec(`select c.path,c.sha,b.size,b.enc,c.seq from changes c left join blobs b on b.sha=c.sha where c.seq>? and c.seq<=? and (c.path=? or (c.path>=? and c.path<?)) and (c.seq>? or (c.seq=? and c.path>?)) order by c.seq,c.path limit ?`, t.from, t.until, t.prefix, t.prefix + "/", t.prefix + "0", t.seq, t.seq, t.path, limit + 1)).toArray() as any[];
      const more = rows.length > limit, page = rows.slice(0, limit);
      const entries = page.filter(r => under(r.path, t!.prefix) && this.pathOk(id.m, r.path)).map(r => ({ path: r.path, sha: r.sha, size: r.size, binary: r.enc === "base64", version: r.seq, deleted: r.sha === null }));
      const last = page.at(-1), next: Token = more ? { ...t, seq: last.seq, path: last.path } : { ...t, mode: "checkpoint", from: t.until, seq: t.until, path: "" };
      const [cursor, read_cursor] = await Promise.all([pack(next), pack(t)]);
      if (capsOf(this.need(peer, "read")) !== id.caps) return { reset_required: true, reason: "permissions_changed" };
      return { mode: t.mode, entries, version: t.until, more, cursor, read_cursor, reset_required: false };
    },
    sync_read: async (peer, a) => {
      const id = await identity(this, peer), t = await unpack(a.cursor, id.epoch), path = normPath(a.path);
      if (!t || !matches(t, this, peer, id) || !under(path, t.prefix)) throw new RelayError(409, "reset_required: invalid snapshot");
      this.need(peer, "read", path);
      const r = this.sql.exec("select sha from changes where path=? and seq<=? order by seq desc limit 1", path, t.until).toArray()[0] as any;
      if (!r?.sha) throw new RelayError(404, "not found at snapshot");
      // Delta pages can contain several versions of a path: clients fetch its state at the page's fixed watermark.
      const b = await this.body(r.sha); this.need(peer, "read", path);
      return { path, sha: r.sha, ...(b.enc === "base64" ? { content_base64: b.data } : { content: b.data }) };
    },
    sync_ack: async (peer, a) => {
      const id = await identity(this, peer), t = await unpack(a.cursor, id.epoch), replica = String(a.replica ?? "");
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(replica)) throw new RelayError(400, "replica: 1-100 letters, numbers, - or _");
      if (!t || t.mode !== "checkpoint" || !matches(t, this, peer, id)) throw new RelayError(409, "reset_required: acknowledge a complete snapshot/checkpoint");
      if (capsOf(this.need(peer, "read")) !== id.caps) throw new RelayError(409, "reset_required: permissions changed");
      this.sql.exec("insert into sync_replicas values(?,?,?,?,?) on conflict(peer,replica) do update set path=excluded.path,version=excluded.version,updated=excluded.updated", peer.id, replica, t.prefix, t.until, new Date().toISOString());
      return { replica, version: t.until };
    },
    sync_status: async (peer) => {
      this.need(peer, "read");
      const replicas = peer.id === "owner" ? this.sql.exec("select peer,replica,path,version,updated from sync_replicas order by updated desc limit 200").toArray() : this.sql.exec("select replica,path,version,updated from sync_replicas where peer=? order by updated desc limit 200", peer.id).toArray();
      return { version: this.headSeq(), replicas };
    },
    sync_publish: async (peer, a) => {
      if (!Array.isArray(a.changes) || !a.changes.length || a.changes.length > 500) throw new RelayError(400, "changes: 1-500 files");
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(String(a.operation_id ?? ""))) throw new RelayError(400, "operation_id: stable identifier required for retries");
      for (const c of a.changes) { prefixOf({ path: c.path }); if (typeof c.if_match !== "string" || !/^(none|[a-f0-9]{64})$/.test(c.if_match)) throw new RelayError(400, "every change needs if_match (previous sha, or none)"); }
      return this.impl.batch(peer, { changes: a.changes, message: a.message, operation_id: a.operation_id });
    },
  };
}
