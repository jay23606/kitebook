// Space DO: commits (the only writer of the tree) and task thread/progress rows. File ops are in fileOps (impl table).
// One layer of the Space class chain (core -> gc -> events -> files -> tasks -> Space in src/space.ts); split for size only, no behavior lives in the chain itself.
import { globMatch, sha256, RelayError, type Peer } from "../ops.ts";
import { b64decode, sha256Bytes, INLINE_MAX, EXTERNAL_AT, EXTERNAL_MAX } from "../blobs.ts";
import * as KB from "../kb.ts";
import { BRIEF_PATH } from "../brief.ts";
import { type Change, now, codeWarn, looksText, guard, normPath, applyEdits, unified } from "./util.ts";
import { SpaceEvents } from "./events.ts";
import type { Space, Op } from "../space.ts";

export class SpaceFiles extends SpaceEvents {
  async commit(actor: Peer, changes: Change[], message: string, receipt?: { id: string; fingerprint: string }) {
    // the assistant brief is the owner's (src/brief.ts): no app writes, moves or deletes it, whatever its path grants; apps use brief_propose
    if (actor.id !== "owner" && actor.id !== "relay" && changes.some(c => c.path === BRIEF_PATH))
      throw new RelayError(403, `${BRIEF_PATH} holds the owner's instructions for assistants: only the owner changes it (Settings -> Instructions for your assistants). Suggest a change with brief_propose`);
    const hashed: { c: Change; sha: string | null; size: number; enc: string; loc: string; inline: string | null; reuse?: boolean }[] = [];
    for (const c of changes) {
      if (c.delete) { hashed.push({ c, sha: null, size: 0, enc: "", loc: "", inline: null }); continue; }
      if (c.copyOf) { const m = this.blobMeta(c.copyOf); hashed.push({ c, sha: c.copyOf, size: m.size, enc: m.enc, loc: m.loc, inline: null, reuse: true }); continue; }
      const enc = c.b64 !== undefined ? "base64" : "utf8"; let reuse = false;
      const bytes = enc === "base64" ? b64decode(c.b64!) : new TextEncoder().encode(c.content ?? "");
      const max = this.store ? EXTERNAL_MAX : INLINE_MAX;
      if (bytes.length > max) throw new RelayError(413, `${c.path} is too large (max ${max} bytes${this.store ? "" : "; configure a blob store (R2, local disk or S3; see BLOB_STORE) for bigger files"})`);
      const sha = await sha256Bytes(bytes);
      let loc = "inline";
      if (this.store && bytes.length > EXTERNAL_AT) {
        const have = this.sql.exec("select loc from blobs where sha=?", sha).toArray()[0];
        if (!have) await this.extPut(sha, bytes); // content-addressed, so a retry or duplicate is harmless
        loc = (have?.loc as string) ?? this.store.kind; reuse = !!have;
      }
      hashed.push({ c, sha, size: bytes.length, enc, loc, inline: loc === "inline" ? (enc === "base64" ? c.b64! : c.content ?? "") : null, reuse });
    }
    // Account storage quota (Dir pushes quota_mb at space init; 0 = none). Counts new blobs only, so edits that shrink or reuse are fine.
    const qmb = Number(this.sql.exec("select v from meta where k='quota_mb'").toArray()[0]?.v ?? 0);
    if (qmb > 0) {
      const fresh = new Map<string, number>(); for (const x of hashed) if (x.sha && !x.c.copyOf && !this.sql.exec("select 1 from blobs where sha=?", x.sha).toArray().length) fresh.set(x.sha, x.size);
      const used = this.sql.exec("select coalesce(sum(size),0) b from blobs").one().b as number, add = [...fresh.values()].reduce((a, b) => a + b, 0), cap = qmb * 1048576;
      if (add && used + add > cap) throw new RelayError(413, `storage quota reached: this space stores ${(used / 1048576).toFixed(2)} MB of ${qmb} MB (history included) and this change adds ${(add / 1048576).toFixed(2)} MB. Delete big files you don't need or ask the server's operator for more`);
    }
    // KB: parse + hash kb/ files now (async), index them inside the transaction below so files and index never disagree
    const kbPrep = new Map<string, any>();
    for (const h of hashed) if (h.c.path.startsWith("kb/") || h.c.path.startsWith("context/")) { // context/<project>.md packs are indexed too
      const text = h.c.delete ? null : h.enc !== "utf8" ? null : h.inline ?? (h.c.copyOf ? (this.sql.exec("select content from blobs where sha=? and loc='inline' and enc='utf8'", h.c.copyOf).toArray()[0]?.content as string ?? null) : null);
      kbPrep.set(h.c.path, await KB.prepare(h.c.path, text));
    }
    // The only await left is this id hash; it is computed BEFORE the checks so that the checks and the
    // writes below run in one synchronous transaction (no await between check and write = no lost update).
    const at = now();
    const id = (await sha256(crypto.randomUUID() + "\n" + at + "\n" + actor.name + "\n" + hashed.map(h => `${h.c.path}:${h.sha}`).join("\n"))).slice(0, 40);
    let replay: any = null; let trimmed = false; const same: string[] = []; let noop = false;
    this.ctx.storage.transactionSync(() => {
      if (receipt) {
        for (const { c } of hashed) this.need(actor, c.delete ? "delete" : "write", c.path); // grants can change during hashing/blob uploads
        const previous = this.sql.exec("select fingerprint,result from sync_receipts where peer=? and id=?", actor.id, receipt.id).toArray()[0] as any;
        if (previous) { if (previous.fingerprint !== receipt.fingerprint) throw new RelayError(409, "operation_id already used with different changes"); replay = JSON.parse(previous.result); return; }
      }
      for (const { c } of hashed) {
        const cur = this.blobAt(c.path);
        if (c.if_match !== undefined && (c.if_match === "none" ? null : c.if_match) !== cur)
          throw new RelayError(409, `conflict on ${c.path}: current ${cur ?? "none"}, expected ${c.if_match}`);
        if (c.delete && cur === null) throw new RelayError(404, `${c.path} not found`);
      }
      // a write whose bytes equal the file as it is (a runner re-advertising after a restart, an idempotent rewrite) is not a change:
      // no commit row, no event fan-out, no KB re-index. A call where every change is like that commits nothing and says unchanged.
      for (let i = hashed.length - 1; i >= 0; i--) { const h = hashed[i]; if (h.sha && h.sha === this.blobAt(h.c.path) && hashed.filter(x => x.c.path === h.c.path).length === 1) { hashed.splice(i, 1); kbPrep.delete(h.c.path); same.push(h.c.path); } }
      if (!hashed.length) {
        noop = true;
        if (receipt) { const shas = Object.fromEntries(same.map(p => [p, this.blobAt(p)])); const commit = this.sql.exec("select id from commits order by seq desc limit 1").toArray()[0]?.id ?? null;
          this.sql.exec("insert into sync_receipts values(?,?,?,?)", actor.id, receipt.id, receipt.fingerprint, JSON.stringify({ commit, shas, unchanged: true })); }
        return;
      }
      // a blob we reused without re-uploading may have been GC'd by retention during the awaits above
      for (const h of hashed) if ((h.reuse && h.loc !== "inline") || h.c.copyOf) if (!this.sql.exec("select 1 from blobs where sha=?", h.sha).toArray().length)
        throw new RelayError(409, `content for ${h.c.path} was just garbage-collected; send it again`);
      const seq = this.sql.exec("insert into commits(id,author,at,message) values(?,?,?,?) returning seq", id, actor.name, at, message).one().seq as number;
      for (const { c, sha, size, enc, loc, inline } of hashed) {
        if (sha && !c.copyOf) this.sql.exec("insert or ignore into blobs(sha,content,size,enc,loc) values(?,?,?,?,?)", sha, inline, size, enc, loc);
        this.sql.exec("insert or replace into changes values(?,?,?)", seq, c.path, sha);
        if (sha) this.sql.exec("insert or replace into tree values(?,?,?,?)", c.path, sha, size, seq);
        else this.sql.exec("delete from tree where path=?", c.path);
      }
      if (receipt) this.sql.exec("insert into sync_receipts values(?,?,?,?)", actor.id, receipt.id, receipt.fingerprint, JSON.stringify({ commit: id, shas: Object.fromEntries([...same.map(p => [p, this.blobAt(p)]), ...hashed.map(h => [h.c.path, h.sha])]) }));
      for (const [p, es] of kbPrep) KB.reindex(this, p, es, seq, actor);
      for (const { sha } of hashed) if (sha) this.sql.exec("delete from blob_put where sha=?", sha); // the upload is owned by a row now
      // repos/** keeps the current tree + a bounded history (git has the real one); superseded versions leave for blob GC to collect
      const rp = hashed.filter(h => h.c.path.startsWith("repos/")).map(h => h.c.path);
      if (rp.length && this.trimRepos(rp)) { this.sql.exec("insert or replace into meta values('gc_dirty',?)", String(Date.now())); trimmed = true; }
    });
    if (replay) return replay;
    if (trimmed) this.armAlarm(Date.now() + 60_000).catch(() => {}); // the alarm marks what the trim orphaned (coalesced, not per commit)
    const shas: Record<string, string | null> = {};
    for (const p of same) shas[p] = this.blobAt(p);
    if (noop) return { commit: (this.sql.exec("select id from commits order by seq desc limit 1").toArray()[0]?.id as string) ?? null, shas, unchanged: true };
    // Log rows stay one per path (poll/stream cursors count them); webhook subscribers get one delivery per commit (see evHooks).
    this.hookBatch = [];
    try { for (const { c, sha } of hashed) { shas[c.path] = sha; this.emit(sha ? "file.written" : "file.deleted", actor, { path: c.path, data: { sha, commit: id } }); } }
    finally { const b = this.hookBatch; this.hookBatch = null; try { this.evHooks(b); } catch (e) { console.error("events hooks", e); } }
    return { commit: id, shas };
  }

  // thread.md / progress.md are rows, not files: re-committing the whole file per line was quadratic (every append wrote a new blob
  // holding all earlier lines, kept by history). `read tasks/<id>/thread.md` still returns the same markdown (taskNotes), with any
  // pre-rows file content first; they go with the task at retention.
  async appendTaskFile(t: any, actor: Peer, file: string, line: string) {
    this.sql.exec("insert into task_notes(task_id,file,actor,at,body) values(?,?,?,?,?)", t.id, file, actor.name, now(), line);
  }
  async taskNotes(path: string): Promise<{ sha: string; content: string } | null> {
    const m = path.match(/^tasks\/([^/]+)\/(thread|progress)\.md$/); if (!m) return null;
    const rows = this.sql.exec("select id, actor, at, body from task_notes where task_id=? and file=? order by id", m[1], m[2] + ".md").toArray() as any[];
    if (!rows.length) return null;
    const legacy = this.blobAt(path), head = legacy ? await this.content(legacy) : "";
    return { sha: `rows:${legacy ? legacy.slice(0, 12) + "." : ""}${rows[rows.length - 1].id}.${rows.length}`, content: head + rows.map(r => `\n## ${r.at} ${r.actor}\n${r.body}\n`).join("") };
  }
}

// fileOps: this space's files ops for the impl table (src/space.ts); `this` is the Space.
export function fileOps(this: Space): Record<string, Op> {
  return {
    ls: async (peer, a) => {
      const m = this.need(peer, "read"), dir = normPath(a.path), pre = dir ? dir + "/" : "", tree = this.treeUnder(pre, a.ref), seen = new Map<string, any>();
      for (const [path, b] of tree) {
        if (!path.startsWith(pre)) continue;
        const rest = path.slice(pre.length), i = rest.indexOf("/");
        if (i < 0) { if (this.pathOk(m, path)) seen.set(rest, { name: rest, path, type: "file", sha: b.sha, size: b.size }); }
        else { const name = rest.slice(0, i), p = pre + name; if (!seen.has(name) && this.dirOk(m, p)) seen.set(name, { name, path: p, type: "dir", sha: null, size: null }); }
      }
      if (dir && !seen.size && ![...tree.keys()].some(p => p.startsWith(pre)) && (tree.size || (pre && (!a.ref || a.ref === "main" || a.ref === "HEAD") && this.sql.exec("select 1 from tree limit 1").toArray().length))) throw new RelayError(404, "no such directory");
      return { path: dir, entries: [...seen.values()].sort((x, y) => x.name.localeCompare(y.name)) };
    },
    stat: async (peer, a) => {
      const path = normPath(a.path); this.need(peer, "read", path);
      const r = this.sql.exec("select sha,size from tree where path=?", path).toArray()[0] as any; if (!r) throw new RelayError(404, "not found");
      const l = this.sql.exec("select c.id commit_id, c.author, c.at from changes ch join commits c on c.seq=ch.seq where ch.path=? order by ch.seq desc limit 1", path).one() as any;
      const bm = this.blobMeta(r.sha);
      return { path, sha: r.sha, size: r.size, binary: bm.enc === "base64", storage: bm.loc, last: { commit: l.commit_id, author: l.author, at: l.at } };
    },
    read: async (peer, a) => {
      const path = normPath(a.path); this.need(peer, "read", path);
      const notes = a.ref ? null : await this.taskNotes(path);
      const sha = notes?.sha ?? this.blobAt(path, a.ref); if (!sha) throw new RelayError(404, "not found");
      if (a.if_none_match === sha) return { path, sha, unchanged: true };
      const b = notes ? { enc: "utf8", data: notes.content } : await this.body(sha);
      if (b.enc === "base64") return { path, sha, content_base64: b.data, binary: true, size: this.blobMeta(sha).size };
      let content = b.data, total: number | undefined;
      if (a.offset !== undefined || a.limit !== undefined) {
        const lines = content.split("\n"); total = lines.length;
        content = lines.slice(a.offset ?? 0, (a.offset ?? 0) + (a.limit ?? lines.length)).join("\n");
      }
      return { path, sha, content, ...(total !== undefined ? { total_lines: total, partial: true } : {}) };
    },
    glob: async (peer, a) => {
      const m = this.need(peer, "read");
      const lit = String(a.pattern ?? "").split(/[*?]/)[0], pre = lit.slice(0, lit.lastIndexOf("/") + 1); // "kb/**" scans kb/ only, not the whole tree
      const files = [...this.treeUnder(pre).keys()].filter(f => globMatch(a.pattern, f) && this.pathOk(m, f)).sort();
      return { files: files.slice(0, 1000), truncated: files.length > 1000 };
    },
    grep: async (peer, a) => {
      // Streams the tree in path order (cursor, never the whole space in memory) and stops at a byte budget: GREP_BUDGET_BYTES env
      // (default 8 MB of file content scanned per call; max_bytes can only lower it). A cut-short search says where it stopped
      // (next_after): pass it back as `after` to continue. Files over 1 MB and binary/external blobs are skipped.
      const m = this.need(peer, "read"), pre = a.path ? normPath(a.path) : "", max = Math.min(Math.max(Number(a.max ?? 200) || 200, 1), 2000);
      let re: RegExp; try { re = new RegExp(a.pattern, a.ignore_case ? "i" : ""); } catch { throw new RelayError(400, "bad regex"); }
      const cap = this.knob("GREP_BUDGET_BYTES", 8 << 20), budget = Math.min(Number(a.max_bytes) > 0 ? Number(a.max_bytes) : cap, cap || Infinity);
      const matches: any[] = []; let scanned = 0, files = 0, last: string | null = null, cut = false;
      const after = a.after ? normPath(a.after) : null, from = after && after >= pre ? after : null;
      const cur = from !== null ? this.sql.exec("select t.path, t.size from tree t join blobs b on b.sha=t.sha where b.loc='inline' and b.enc='utf8' and t.size<=? and t.path>? order by t.path", 1 << 20, from).toArray()
        : this.sql.exec("select t.path, t.size from tree t join blobs b on b.sha=t.sha where b.loc='inline' and b.enc='utf8' and t.size<=? and t.path>=? order by t.path", 1 << 20, pre).toArray(); // paths + sizes only: file text is read one file at a time below
      for (const r of cur) {
        const path = r.path as string;
        if (pre && path !== pre && !path.startsWith(pre + "/")) { if (path > pre + "/") break; continue; } // sorted: past the directory = done
        if (!this.pathOk(m, path)) continue;
        if (files > 0 && scanned + Number(r.size ?? 0) > budget) { cut = true; break; }
        const c = this.sql.exec("select b.content from tree t join blobs b on b.sha=t.sha where t.path=?", path).one().content as string; // one file's text at a time
        scanned += Number(r.size ?? c.length); files++; last = path;
        if (c.includes("\u0000")) continue;
        const lines = c.split("\n");
        for (let i = 0; i < lines.length && matches.length <= max; i++) if (re.test(lines[i])) matches.push({ path, line: i + 1, text: lines[i].slice(0, 300) });
        if (matches.length > max) break;
      }
      const more = matches.length > max;
      return { matches: matches.slice(0, max), truncated: more || cut, scanned_bytes: scanned, files_scanned: files,
        ...(cut && !more ? { budget_exhausted: true, next_after: last, hint: `byte budget (${budget} bytes) reached; call grep again with after=${JSON.stringify(last)} to continue, or narrow path` } : {}) };
    },
    write: async (peer, a) => {
      const path = normPath(a.path); this.need(peer, "write", path);
      if (a.content === undefined && a.content_base64 === undefined) throw new RelayError(400, "missing content (or content_base64)");
      if (a.content_base64 !== undefined) { const u = b64decode(String(a.content_base64)); guard(path, looksText(u) ? new TextDecoder().decode(u) : undefined); } else guard(path, String(a.content));
      const ch: Change = a.content_base64 !== undefined ? { path, b64: String(a.content_base64), if_match: a.if_match } : { path, content: String(a.content), if_match: a.if_match };
      const r = await this.commit(peer, [ch], a.message ?? `write ${path}`), w = codeWarn(path);
      return { path, sha: r.shas[path], commit: r.commit, ...((r as any).unchanged ? { unchanged: true } : {}), ...(w ? { warning: w, hint: "code goes to git: submit it with the change op (or push a branch), not into the space" } : {}) };
    },
    batch: async (peer, a) => {
      if (!Array.isArray(a.changes) || !a.changes.length || a.changes.length > 500) throw new RelayError(400, "changes: 1-500 entries");
      const cs: Change[] = [], skipped: { path: string; reason: string }[] = [];
      for (const c of a.changes) try { cs.push(await (async (): Promise<Change> => {
        const path = normPath(c.path); this.need(peer, c.delete ? "delete" : "write", path);
        if (c.sha && !c.delete && c.content === undefined && c.content_base64 === undefined && !c.edits) { // reuse a blob the server already has (see `has`)
          guard(path);
          if (!this.sql.exec("select 1 from blobs where sha=?", c.sha).toArray().length) throw new RelayError(409, `${path}: blob ${c.sha} not on server; send content`);
          return { path, copyOf: c.sha, if_match: c.if_match };
        }
        if (c.edits) { // string edits against the current file, applied in order
          const sha = this.blobAt(path); if (!sha) throw new RelayError(404, `${path} not found`);
          const content = applyEdits(path, await this.content(sha), c.edits); guard(path, content);
          return { path, content, if_match: c.if_match ?? sha };
        }
        if (c.content_base64 !== undefined && !c.delete) { const bytes = b64decode(String(c.content_base64)); guard(path, looksText(bytes) ? new TextDecoder().decode(bytes) : undefined); return { path, b64: String(c.content_base64), if_match: c.if_match }; }
        if (!c.delete) guard(path, String(c.content ?? ""));
        return { path, content: c.delete ? undefined : String(c.content ?? ""), delete: !!c.delete, if_match: c.if_match };
      })()); } catch (e: any) {
        if (a.skip_rejected && e instanceof RelayError && e.status === 422) skipped.push({ path: String(c.path), reason: e.message }); else throw e;
      }
      if (!cs.length) return { commit: null, shas: {}, skipped };
      if (new Set(cs.map(c => c.path)).size !== cs.length) throw new RelayError(400, "one entry per path (put several edits in one entry's edits list)");
      if (a.operation_id !== undefined && !/^[a-zA-Z0-9_-]{1,100}$/.test(String(a.operation_id))) throw new RelayError(400, "invalid operation_id");
      const receipt = a.operation_id ? { id: String(a.operation_id), fingerprint: await sha256(JSON.stringify({ changes: a.changes, message: a.message ?? null })) } : undefined;
      const r = await this.commit(peer, cs, a.message ?? `batch ${cs.length} changes`, receipt);
      const warn = cs.filter(c => !c.delete && codeWarn(c.path)).map(c => c.path);
      return { commit: r.commit, shas: r.shas, ...(skipped.length ? { skipped } : {}), ...(warn.length ? { warning: "code_outside_change", warning_paths: warn.slice(0, 50) } : {}) };
    },
    has: async (peer, a) => {
      this.need(peer, "write");
      const shas: string[] = (a.shas ?? []).slice(0, 5000);
      const have = new Set<string>();
      for (let i = 0; i < shas.length; i += 100) { const part = shas.slice(i, i + 100);
        for (const r of this.sql.exec(`select sha from blobs where sha in (${part.map(() => "?").join(",")})`, ...part)) have.add(r.sha as string); }
      return { missing: shas.filter(x => !have.has(x)) };
    },
    patch: async (peer, a) => {
      const path = normPath(a.path); this.need(peer, "write", path);
      const sha = this.blobAt(path); if (!sha) throw new RelayError(404, "not found");
      const edits = a.edits ?? [{ old: a.old, new: a.new }];
      const content = applyEdits(path, await this.content(sha), edits); guard(path, content);
      const r = await this.commit(peer, [{ path, content, if_match: a.if_match ?? sha }], `patch ${path}`);
      return { path, sha: r.shas[path], commit: r.commit };
    },
    mv: async (peer, a) => {
      const from = normPath(a.from), to = normPath(a.to);
      this.need(peer, "delete", from); this.need(peer, "write", to); guard(to);
      const sha = this.blobAt(from); if (!sha) throw new RelayError(404, "not found");
      const r = await this.commit(peer, [{ path: to, copyOf: sha, if_match: "none" }, { path: from, delete: true, if_match: sha }], `mv ${from} ${to}`);
      return { from, to, commit: r.commit };
    },
    rm: async (peer, a) => {
      const path = normPath(a.path); this.need(peer, "delete", path);
      if (!this.blobAt(path)) throw new RelayError(404, "not found");
      const r = await this.commit(peer, [{ path, delete: true, if_match: a.if_match }], `rm ${path}`);
      return { path, commit: r.commit };
    },
    log: async (peer, a) => {
      const path = a.path ? normPath(a.path) : undefined; this.need(peer, "read", path);
      const lim = Math.min(a.limit ?? 20, 200);
      const rows = path
        ? this.sql.exec("select id, author, at, message from commits where seq in (select seq from changes where path=? or path like ?) order by seq desc limit ?", path, path + "/%", lim).toArray()
        : this.sql.exec("select id, author, at, message from commits order by seq desc limit ?", lim).toArray();
      return { commits: rows.map(r => ({ commit: r.id, author: r.author, at: r.at, message: r.message })) };
    },
    diff: async (peer, a) => {
      const m = this.need(peer, "read"), path = a.path ? normPath(a.path) : undefined;
      if (path && !this.pathOk(m, path) && !this.dirOk(m, path)) throw new RelayError(403, "no read access");
      const A = this.treeAt(a.a), B = this.treeAt(a.b ?? "main"), out: string[] = [];
      for (const p of [...new Set([...A.keys(), ...B.keys()])].sort()) {
        if (path && p !== path && !p.startsWith(path + "/")) continue; if (!this.pathOk(m, p)) continue;
        const x = A.get(p)?.sha, y = B.get(p)?.sha; if (x === y) continue;
        const bin = [x, y].some(s => s && (this.blobMeta(s).enc !== "utf8" || this.blobMeta(s).size > EXTERNAL_AT));
        out.push(bin ? `diff --git a/${p} b/${p}\nBinary or large file differs (${x ?? "none"} -> ${y ?? "none"})\n`
          : unified(p, x ? await this.content(x) : null, y ? await this.content(y) : null));
      }
      return { diff: out.join("") };
    },
    changes: async (peer, a) => {
      this.need(peer, "read");
      if (a.wait && !this.sql.exec("select 1 from events where seq>? limit 1", a.since ?? 0).toArray().length) await this.wait(Number(a.wait));
      const rows = this.sql.exec("select * from events where seq>? order by seq limit ?", a.since ?? 0, Math.min(a.limit ?? 200, 1000)).toArray();
      const sp = this.spaceId;
      const evs = rows.map(r => ({ seq: r.seq, space: sp, type: r.type, path: r.path ?? undefined, task: r.task_id ?? undefined, actor: r.actor, data: JSON.parse(r.data as string), at: r.at })).filter(e => this.visible(peer, e));
      return { events: evs, cursor: rows.length ? rows[rows.length - 1].seq : (a.since ?? 0) };
    },
  };
}
