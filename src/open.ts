// /open: `kitebook open` (or the tray's "Open dashboard") signs a one-time token with this machine's device key (client/device.ts) and opens
// <url>/open#t=<token>&n=<CLI nonce>[&trust=<k>][&to=settings]. The fragment never reaches a proxy, tunnel log or request line; the page
// strips it (history.replaceState) and POSTs it once. The server checks the device's signature, single use, 60 s, and the nonce the token
// is bound to, then sets an HttpOnly SameSite=Strict cookie tied to that device (revoking the device ends it), plus the Better Auth session
// the consent page still uses (linked to the device, so it dies with it). /open is public on purpose: the token is the credential.
import { THEME_CSS, BASE_CSS } from "./ui.ts";
import { PAGE_HEADERS } from "./approve.ts";
import { devCookie, parseSigned } from "./devices.ts";
import { ACCT_RE } from "./dir.ts";
import { setHint } from "./session.ts";
type H = { dir: (a: string) => any };
const j = (b: any, status = 200, h: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...h } });
const b64 = (n: number) => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(n)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const devSessCookie = (url: URL, acct: string, v: string, maxAge: number) => `${devCookie(acct)}=${v}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${url.protocol === "https:" ? "; Secure" : ""}`;
const WHY: Record<string, string> = { used: "That link was already used (each one works once). Run kitebook open again.", expired: "That link expired (they work for 60 seconds). Run kitebook open again.",
  nonce: "That link is incomplete (its nonce doesn't match). Run kitebook open again and use the link it opens.", device: "The device that made this link isn't an active device of this Kitebook (revoked, or still waiting for approval).",
  bad: "That link isn't valid. Run kitebook open again." };
const page = (n: string) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta name="color-scheme" content="light dark"><title>Kitebook</title><style>${THEME_CSS}${BASE_CSS}body{max-width:32rem;margin:0 auto;padding:22vh 24px 0;text-align:center}.brand{font-size:20px;font-weight:600;margin:0 0 12px}#m{font-size:19px;color:var(--mut)}</style></head>
<body><p class="brand">Kitebook</p><p id="m" role="status">Opening your Kitebook…</p><script nonce="${n}">
const f=new URLSearchParams(location.hash.slice(1));history.replaceState(null,"",location.pathname);const m=document.getElementById("m");
const t=f.get("t"),nn=f.get("n"),tr=f.get("trust"),to=f.get("to")==="settings"?"/settings":"/start";
if(!t||!nn){m.textContent="Nothing to open here. Run kitebook open on a computer with Kitebook installed."}else
fetch("/open",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({t,n:nn})}).then(r=>r.json()).then(r=>{if(!r.ok){m.textContent=r.error;return}
try{if(tr&&/^[A-Za-z0-9_-]{20,64}$/.test(tr))sessionStorage.setItem("relay-trust",tr)}catch(e){}location.replace(to)}).catch(()=>{m.textContent="Couldn't reach Kitebook. Run kitebook open again."});
</script></body></html>`;
export async function openFetch(req: Request, env: any, url: URL, h: H): Promise<Response | null> {
  if (url.pathname !== "/open") return null;
  if (req.method === "GET") { const n = b64(16); return new Response(page(n), { headers: PAGE_HEADERS(n) }); }
  if (req.method !== "POST") return j({ ok: false, error: "GET or POST" }, 405);
  if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) return j({ ok: false, error: "send JSON" }, 415);
  const og = req.headers.get("origin"); if (og && og !== url.origin) return j({ ok: false, error: "cross-origin request refused" }, 403);
  const lim = await env.DIR.get(env.DIR.idFromName("oauth:global")).oauth("rate", `open:ip:${req.headers.get("cf-connecting-ip") ?? "local"}`, 30) as { ok: boolean; retry_after: number };
  if (!lim.ok) return j({ ok: false, error: `Too many tries from your address; wait ${Math.ceil(lim.retry_after / 60)} min.` }, 429, { "retry-after": String(lim.retry_after) });
  const b: any = await req.json().catch(() => ({})), s = parseSigned(String(b.t ?? "")), acct = String(s?.p?.a ?? "");
  if (!s || !ACCT_RE.test(acct)) return j({ ok: false, error: WHY.bad }, 400);
  const d = h.dir(acct), r = await d.dev("openUse", String(b.t), String(b.n ?? ""));
  if (r.state !== "ok") return j({ ok: false, error: WHY[r.state] ?? WHY.bad, state: r.state }, r.state === "bad" ? 400 : r.state === "device" ? 403 : 410);
  await d.ensureMain().catch(() => {});
  const ua = req.headers.get("user-agent") ?? "", baSet: string[] = await d.baMint(url.origin, ua).catch(() => []);
  const baCookie = baSet.map(c => c.split(";")[0]).join("; "), ba = baCookie ? await d.baSession(url.origin, baCookie).catch(() => null) : null;
  if (ba) await d.baOriginSet(url.origin).catch(() => {}); // so revoking the device can end this Better Auth session later, without a request
  const ss = await d.dev("sessNew", r.device.id, ua, ba?.id ?? null);
  const res = j({ ok: true, result: { account: acct, device: { id: r.device.id, name: r.device.name } } });
  res.headers.append("set-cookie", devSessCookie(url, acct, ss.secret, ss.max_age));
  for (const c of baSet) res.headers.append("set-cookie", c);
  res.headers.append("set-cookie", setHint(url, acct));
  return res;
}
