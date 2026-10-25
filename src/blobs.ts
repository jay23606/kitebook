// Where big or binary file bodies live. The DO keeps only metadata (sha, size, location) for them.
// Pick with BLOB_STORE=r2|disk|s3|inline, or leave it unset to auto-detect in this order:
//   r2:     an R2 bucket binding `BLOBS` (Cloudflare; under `cf dev` it's simulated on local disk in .relay-data/)
//   disk:   a workerd writable disk service bound as `BLOB_DISK` (plain workerd self-host; see selfhost/config.capnp)
//   s3:     any S3-compatible store (MinIO, Backblaze B2, AWS, R2's S3 API) via S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY [, S3_REGION]
//   inline: none of the above; bodies stay in DO SQLite (files capped at INLINE_MAX)
// (The selector isn't called BLOBS because that name is already the R2 binding.)
// Every backend uses the same object names (blobs/<sha256> on R2/S3, <sha256> under the disk root), so moving
// blobs between backends is a plain copy, and reads re-hash the bytes so a torn or tampered object is caught, not served.
import { RESOURCE, resourceIO, resourceBytes } from "../client/resource-guard.ts";
import { AwsClient } from "aws4fetch";

export const INLINE_MAX = 1_500_000;  // DO SQLite value cap is 2 MB
export const EXTERNAL_AT = 256_000;   // above this, prefer the external store when there is one
export const EXTERNAL_MAX = 25_000_000; // DO RPC messages cap at 32 MiB

export type BlobKind = "r2" | "disk" | "s3";
// Blob GC across spaces: the store is shared by every space (and account) on the server and objects are content-addressed, so two
// spaces can hold the same object. Each space that holds one keeps a reference marker refs/<sha>/<space key> next to it (written
// BEFORE the object, so a crash leaves a marker, never an unowned object); a space's GC drops its own marker and deletes the object
// only when no marker is left. list() walks blobs/ for the operator's store-wide audit of objects nobody marked (legacy, pre-marker).
export interface BlobStore { kind: BlobKind; put(sha: string, body: Uint8Array): Promise<void>; get(sha: string): Promise<Uint8Array | null>; del(sha: string): Promise<void>;
  ref(sha: string, key: string): Promise<void>; unref(sha: string, key: string): Promise<void>; refs(sha: string): Promise<number>;
  list(cursor?: string): Promise<{ items: { sha: string; size?: number; uploaded?: number }[]; cursor?: string }>; }
type Raw = Omit<BlobStore, "kind">;

const s3Ready = (env: any) => !!(env.S3_ENDPOINT && env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY);
export function blobKind(env: any): BlobKind | null {
  const want = String(env.BLOB_STORE ?? "").trim().toLowerCase();
  if (want === "inline" || want === "none") return null;
  const have = { r2: !!env.BLOBS?.put, disk: !!env.BLOB_DISK?.fetch, s3: s3Ready(env) };
  if (want) { // explicit choice: a missing backend is a config error, never a silent fall back to inline (that would cap files at 1.5 MB)
    if (!(want in have)) throw new Error(`BLOB_STORE=${want}: expected r2, disk, s3 or inline`);
    if (!have[want as BlobKind]) throw new Error(`BLOB_STORE=${want} but it isn't configured (${{ r2: "no R2 binding BLOBS", disk: "no disk service binding BLOB_DISK", s3: "S3_ENDPOINT/S3_BUCKET/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY not all set" }[want as BlobKind]})`);
    return want as BlobKind;
  }
  return have.r2 ? "r2" : have.disk ? "disk" : have.s3 ? "s3" : null;
}

function raw(kind: BlobKind, env: any): Raw {
  if (kind === "r2") {
    const b = env.BLOBS as R2Bucket;
    return { async put(sha, body) { await b.put(`blobs/${sha}`, body, { customMetadata: { sha } }); },
      async get(sha) { const o = await b.get(`blobs/${sha}`); return o ? new Uint8Array(await o.arrayBuffer()) : null; },
      async del(sha) { await b.delete(`blobs/${sha}`); },
      async ref(sha, key) { await b.put(`refs/${sha}/${key}`, new Uint8Array(0)); }, async unref(sha, key) { await b.delete(`refs/${sha}/${key}`); },
      async refs(sha) { return (await b.list({ prefix: `refs/${sha}/`, limit: 10 })).objects.length; },
      async list(cursor) { const r = await b.list({ prefix: "blobs/", limit: 1000, cursor });
        return { items: r.objects.map((o: any) => ({ sha: o.key.slice(6), size: o.size, uploaded: o.uploaded?.getTime() })), cursor: r.truncated ? r.cursor : undefined }; } };
  }
  if (kind === "disk") { // workerd `disk = (path=..., writable=true)`: GET/PUT/DELETE on paths under its root, parent dirs created on PUT
    const d = env.BLOB_DISK as Fetcher, url = (sha: string) => `http://blob-disk/${sha}`;
    return { async put(sha, body) { const r = await d.fetch(url(sha), { method: "PUT", body }); if (!r.ok) throw new Error(`disk put ${r.status} (is the disk service writable=true?)`); },
      async get(sha) { const r = await d.fetch(url(sha)); if (r.status === 404) { await r.body?.cancel(); return null; } if (!r.ok) throw new Error(`disk get ${r.status}`); return new Uint8Array(await r.arrayBuffer()); },
      async del(sha) { const r = await d.fetch(url(sha), { method: "DELETE" }); if (!r.ok && r.status !== 404) throw new Error(`disk delete ${r.status}`); },
      async ref(sha, key) { const r = await d.fetch(`http://blob-disk/refs/${sha}/${key}`, { method: "PUT", body: "" }); if (!r.ok) throw new Error(`disk ref ${r.status}`); },
      async unref(sha, key) { const r = await d.fetch(`http://blob-disk/refs/${sha}/${key}`, { method: "DELETE" }); await r.body?.cancel(); if (!r.ok && r.status !== 404) throw new Error(`disk unref ${r.status}`);
        if ((await this.refs(sha)) === 0) await (await d.fetch(`http://blob-disk/refs/${sha}`, { method: "DELETE" })).body?.cancel(); }, // tidy the empty dir (best effort)
      async refs(sha) { return (await dirList(d, `refs/${sha}`)).length; }, // a directory GET lists it as JSON [{name, type}]
      async list() { return { items: (await dirList(d, "")).filter(e => e.type === "file" && SHA.test(e.name)).map(e => ({ sha: e.name })) }; } };
  }
  const aws = new AwsClient({ accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY, service: "s3", retries: 0, region: env.S3_REGION ?? "auto" });
  const base = `${String(env.S3_ENDPOINT).replace(/\/$/, "")}/${env.S3_BUCKET}`, url = (sha: string) => `${base}/blobs/${sha}`;
  const request = (path: string, init: RequestInit = {}, read = false, missing = false) => resourceIO(async signal => {
    const r = await aws.fetch(path, { ...init, signal });
    if (r.status === 404 && missing) { await r.body?.cancel(); return null; }
    if (!r.ok) { await r.body?.cancel(); throw new Error(`s3 request HTTP ${r.status}`); }
    if (read) return resourceBytes(r, EXTERNAL_MAX);
    await r.body?.cancel(); return new Uint8Array();
  }, RESOURCE.storageMs);
  const s3List = async (prefix: string, max: number, token?: string) => {
    const bytes = await request(`${base}?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=${max}${token ? `&continuation-token=${encodeURIComponent(token)}` : ""}`, {}, true);
    const x = new TextDecoder().decode(bytes!), tag = (b: string, t: string) => b.match(new RegExp(`<${t}>([^<]*)</${t}>`))?.[1];
    const items = [...x.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(m => ({ key: tag(m[1], "Key") ?? "", size: Number(tag(m[1], "Size") ?? 0), uploaded: Date.parse(tag(m[1], "LastModified") ?? "") || undefined }));
    return { items, cursor: tag(x, "IsTruncated") === "true" ? tag(x, "NextContinuationToken") : undefined };
  };
  return { async put(sha, body) { await request(url(sha), { method: "PUT", body }); },
    async get(sha) { return request(url(sha), {}, true, true); },
    async del(sha) { await request(url(sha), { method: "DELETE" }, false, true); },
    async ref(sha, key) { await request(`${base}/refs/${sha}/${key}`, { method: "PUT", body: "" }); },
    async unref(sha, key) { await request(`${base}/refs/${sha}/${key}`, { method: "DELETE" }, false, true); },
    async refs(sha) { return (await s3List(`refs/${sha}/`, 10)).items.length; },
    async list(cursor) { const r = await s3List("blobs/", 1000, cursor); return { items: r.items.map(i => ({ ...i, sha: i.key.slice(6) })), cursor: r.cursor }; } };
}

async function dirList(d: Fetcher, path: string): Promise<{ name: string; type: string }[]> {
  const r = await d.fetch(`http://blob-disk/${path}`); if (r.status === 404) { await r.body?.cancel(); return []; }
  if (!r.ok) throw new Error(`disk list ${r.status}`); const j: any = await r.json().catch(() => null); return Array.isArray(j) ? j : [];
}
const SHA = /^[0-9a-f]{64}$/; // also keeps a key from ever escaping the disk root
export function blobStore(env: any): BlobStore | null {
  const kind = blobKind(env); if (!kind) return null;
  const r = raw(kind, env), ok = (sha: string) => { if (!SHA.test(sha)) throw new Error(`bad blob key ${sha.slice(0, 80)}`); };
  return { kind,
    async put(sha, body) { ok(sha); await r.put(sha, body); },
    async get(sha) { ok(sha); const u = await r.get(sha); if (u && await sha256Bytes(u) !== sha) throw new Error(`blob ${sha} is corrupt in ${kind} storage (content hash mismatch)`); return u; },
    async del(sha) { ok(sha); await r.del(sha); },
    async ref(sha, key) { ok(sha); ok(key); await r.ref(sha, key); }, async unref(sha, key) { ok(sha); ok(key); await r.unref(sha, key); },
    async refs(sha) { ok(sha); return await r.refs(sha); }, async list(cursor) { return await r.list(cursor); } };
}

export const b64encode = (u: Uint8Array) => { let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
export const b64decode = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
export async function sha256Bytes(u: Uint8Array) {
  const d = await crypto.subtle.digest("SHA-256", u);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}
