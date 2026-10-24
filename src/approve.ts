// Phone review page for approvals: GET /approve/<acct>.<space>.<one-time id>. The ntfy notification opens it (a "view"
// action), so the owner sees the whole task before deciding, not just a truncated push text. Approve/Reject POST JSON back
// to the same URL (one decision per id, 5-minute life). With the owner's passkey opt-in, Approve signs the runner's approval
// nonce with WebAuthn and the runner (not the server) verifies the signature. The same page registers that passkey (kind register).
import { OWNER_JS } from "./policy-ui.ts";
import { THEME_CSS, BASE_CSS } from "./ui.ts";
export const esc = (s: any) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export const PAGE_HEADERS = (nonce: string, connect = "") => ({
  "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-frame-options": "DENY", "x-content-type-options": "nosniff",
  "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'${connect ? " " + connect : ""}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
});
// the runner's access setting, said plainly (the raw value stays in brackets so it matches runner.json)
const ACCESS: Record<string, string> = { worktree: "its own copy of the project only (worktree)", full: "your whole Mac (full)" };
// C23, above the fold: who asked, why it asks (or why it ran on its own), what it can touch, the shared notes it gets and who wrote
// them. Plain words only. An older runner sends none of the new view fields, so each part falls back to what the view always had.
export function trustParts(v: any, row: (k: string, x: any) => string): string {
  const t = v.touch ?? {}, notes: any[] = Array.isArray(v.kb_notes) ? v.kb_notes : (v.kb_untrusted ?? []).map((x: any) => ({ ...x, trusted: false }));
  const access = t.access ?? (ACCESS[v.access] ?? v.access ?? null);
  const paths = t.paths ?? (Array.isArray(v.scope) && v.scope.length ? v.scope : null);
  return `<section class="who"><h2>Who asked</h2><p class="big">${esc(v.asked_by ?? v.from ?? "unknown")}</p>
<h2>Why you're asked</h2><p>${esc(v.why ?? (v.signature ? `Not run on its own: ${v.signature}.` : "This Mac asks you before running this."))}</p>
<h2>What it can touch</h2><table class="touch">${row("project", t.project ?? v.project ?? "none (machine task)")}${row("access level", access)}${row("allowed paths", paths)}${row("internet", t.network)}${row("pushing", t.push)}</table>
<h2>Shared notes it gets</h2>${notes.length ? `<ul class="kb">${notes.map((n: any) => `<li>${esc(n.title || n.id)} <span class="by">by ${esc(n.author ?? "unknown")}${n.trusted ? "" : " (not on your trusted list: shown to the agent as untrusted)"}</span></li>`).join("")}</ul>` : `<p class="note">${Array.isArray(v.kb_notes) ? "None." : "Not reported by this runner."}</p>`}</section>`;
}
export function approvePage(a: any, nonce: string): string {
  const v = a.view ?? {}, reg = a.kind === "register", live = a.state === "pending", conn = v.gate === "connect"; // conn: a new app connecting (no task)
  const row = (k: string, x: any) => x === undefined || x === null || x === "" || (Array.isArray(x) && !x.length) ? "" : `<tr><th>${esc(k)}</th><td>${esc(Array.isArray(x) ? x.join(", ") : x)}</td></tr>`;
  const head = reg ? "Register a passkey" : conn ? (v.login ? "Sign in a browser?" : "Connect a new app?") : v.gate === "irreversible" ? "Allow irreversible actions?" : v.gate === "push" ? "Approve push?" : v.gate === "steer" ? "Approve new instructions for a running task?" : v.gate === "agent" ? "Allow what the agent asks?" : "Approve task?";
  const body = reg ? `<p>This one-time link adds a passkey that must sign every phone approval for runner <b>${esc(v.runner)}</b>. Only open it if you just ran <code>runner.ts passkey register</code>.</p>`
    : conn ? `<section class="who"><p class="big">${esc(v.title)}</p><p>${esc(v.can)}</p>${v.login ? "" : v.replace ? `<p>It replaces the old ${esc(v.name)} connection, which stops working.</p>` : `<p>It will be called ${esc(v.name)}.</p>`}</section><p class="note">Approve only if you are connecting it right now and the code above matches the one in your browser.</p>`
    : "";
  // a task (owner, 2026-10-22: "absolutely short"): the title, one line (who asked, what it touches, the code), Approve / Reject, then all
  // the rest folded under Details: who/why/what it can touch, the shared notes, the instructions, the agent and checks
  const t = v.touch ?? {}, full = v.access === "full" || /whole Mac/.test(String(t.access ?? ""));
  const touches = full ? "your whole Mac" : (t.project ?? v.project) ? `${esc(t.project ?? v.project)}` : "no project";
  const details = reg || conn ? "" : `<details class="more"><summary>Details</summary>${trustParts(v, row)}
<h2>Instructions</h2><pre>${esc(v.instructions)}</pre>${v.acceptance ? `<h2>Acceptance</h2><pre>${esc(v.acceptance)}</pre>` : ""}${v.detail ? `<pre>${esc(v.detail)}</pre>` : ""}<table>${row("task", v.title)}${row("Mac", v.runner)}${row("agent", [v.agent, v.model].filter(Boolean).join(" / "))}${row("checks it runs", v.verify)}${row("requested", v.requested)}${row("follows up on", v.continue_from)}</table></details>`;
  const state = live ? "" : `<p class="st">This request is ${esc(a.state)}.</p>`;
  const btns = !live ? "" : reg ? `<button id="reg">Create passkey</button>` : `<button id="ok">${a.passkey ? "Approve with passkey" : "Approve"}</button><button id="no" class="no">Reject</button>`;
  // "Always allow <app> in <project>" (the runner sends view.allow for a run in a real project): approves this one AND signs, in this
  // browser, a standing permission for that app in that project, so the next task there runs without asking (change it on /start)
  const al = live && !reg && (v.gate ?? "run") === "run" && v.allow?.app && v.allow?.project ? { app: String(v.allow.app), project: String(v.allow.project) } : null;
  const always = al ? `<div class="alw"><button id="always" class="alt" title="Approves this task and lets ${esc(al.app)} run tasks in ${esc(al.project)} on its own from now on (pushing still asks). Undo it in Settings, Connected apps.">Always allow ${esc(al.app)} in ${esc(al.project)}</button></div>` : "";
  const data = JSON.stringify({ kind: a.kind, challenge: a.challenge, passkey: a.passkey ?? null, name: v.name ?? "owner", allow: al, conn, login: !!v.login }).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta name="color-scheme" content="light dark"><title>Kitebook: ${esc(head)}</title>
<style>${THEME_CSS}${BASE_CSS}
/* the review page: the decision first (title, one line, Approve / Reject), the rest folded under Details */
body{max-width:640px;margin:0 auto;padding:24px 20px 40px}h1{font-size:28px;margin:8px 0 12px}h2{font-size:18px;margin:24px 0 8px}
h1.ask{font-size:15px;font-weight:600;color:var(--mut);margin:8px 0 4px}.task{font-size:28px;font-weight:600;line-height:1.25;letter-spacing:-.01em;margin:0 0 8px}
.lede{color:var(--mut);font-size:16px;margin:0}.lede b{color:var(--fg);font-weight:600}
table{border-collapse:collapse;width:100%;margin-top:16px}th{text-align:left;color:var(--mut);font-weight:400;padding:10px 16px 10px 0;vertical-align:top;white-space:nowrap;border-top:1px solid var(--line);width:1%}td{padding:10px 0;word-break:break-word;border-top:1px solid var(--line)}
pre{max-height:55vh;overflow:auto;font:16px/1.55 -apple-system,BlinkMacSystemFont,system-ui,sans-serif}
.hash{font:600 15px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--fg)}
.bar{display:flex;gap:12px;margin:24px 0 8px}.bar button{flex:1;font-size:18px;min-height:52px;background:var(--acc);color:var(--onacc)}.bar button:hover{background:var(--acc2)}.bar button.no{flex:0 0 auto;background:none;color:var(--danger);font-weight:600;padding:12px 24px}.bar button.no:hover{background:var(--soft)}
.st{font-weight:600}.who p{margin:0}.big{font-size:17px;font-weight:600}.who h2{font-size:15px;color:var(--mut);margin:20px 0 4px}.kb{margin:4px 0;padding-left:20px}.by,.note{color:var(--mut);font-size:15px}
.alw{margin:0 0 8px}button.alt{background:none;color:var(--link);font-weight:400;min-height:40px;padding:8px 0;text-align:left}button.alt:hover{background:none;text-decoration:underline}
details.more{margin:24px 0 0;border-top:1px solid var(--line)}details.more>summary{font-size:16px;color:var(--mut)}
@media (max-width:560px){h1{font-size:25px}.task{font-size:25px}}
</style></head><body>
${!reg && !conn && v.title ? `<h1 class="ask">${esc(head)}</h1><p class="task">${esc(v.title)}</p>` : `<h1>${esc(head)}</h1>`}${reg ? "" : `<p class="lede">${conn ? "" : `From <b>${esc(v.asked_by ?? v.from ?? "unknown")}</b> &middot; touches <b>${touches}</b> &middot; `}code <span class="hash">${esc(v.hash)}</span> &middot; until <time id="exp" data-ms="${esc(Number(a.expires_at) || 0)}">${esc(new Date(a.expires_at).toISOString().slice(11, 16))} UTC</time></p>`}${!reg && v.approvals_down ? `<p class="st">Push approvals are down (${esc(v.approvals_down)}), so this page is how you decide. Nothing was declined.</p>` : ""}
${body}${state}<div class="bar">${btns}</div>${always}<p id="msg" class="st"></p>${!reg && a.task ? `<p id="track"${live ? " hidden" : ""}><a href="/start#task-${esc(encodeURIComponent(a.task))}">Track it &rarr;</a></p>` : ""}${details}
<script id="ask" type="application/json">${data}</script>
<script nonce="${nonce}">
${al ? OWNER_JS : ""}
const A=JSON.parse(document.getElementById("ask").textContent),enc=s=>new TextEncoder().encode(s),msg=t=>document.getElementById("msg").textContent=t;
const b64u=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,""),unb=s=>Uint8Array.from(atob(s.replace(/-/g,"+").replace(/_/g,"/")),c=>c.charCodeAt(0));
const ex=document.getElementById("exp");if(ex){const d=new Date(+ex.dataset.ms);if(+d)ex.textContent=d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})} // the server only knows UTC
const off=()=>document.querySelectorAll("button").forEach(b=>b.disabled=true);
async function send(body){off();msg("Sending…");try{const r=await fetch(location.pathname,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});const j=await r.json();if(j.ok&&document.getElementById("track"))document.getElementById("track").hidden=false;msg(j.ok?(j.result.state==="rejected"?"Rejected.":j.result.state==="registered"?"Passkey sent to your runner. You can close this page.":A.conn?(A.login?"Approved. That browser is signed in now.":"Approved. The app finishes connecting on its own."):"Approved. The runner checks it and starts."):"Not accepted: "+j.error);}catch(e){msg("Network error: "+e.message)}}
const ok=document.getElementById("ok"),no=document.getElementById("no"),reg=document.getElementById("reg");
if(no)no.onclick=()=>send({decision:"rejected"});
if(ok)ok.onclick=async()=>{const body={decision:"approved"};if(A.passkey){try{const c=await navigator.credentials.get({publicKey:{challenge:enc(A.challenge),rpId:A.passkey.rp_id,allowCredentials:A.passkey.allow.map(id=>({type:"public-key",id:unb(id)})),userVerification:"required",timeout:120000}});
body.assertion={id:c.id,clientDataJSON:b64u(c.response.clientDataJSON),authenticatorData:b64u(c.response.authenticatorData),signature:b64u(c.response.signature)}}catch(e){return msg("Passkey cancelled: "+e.message)}}send(body)};
const alw=document.getElementById("always");
if(alw)alw.onclick=async()=>{alw.disabled=true;msg("Saving your permission…");try{const[acct,space]=location.pathname.split("/").pop().split(".");const r=await OWN.allow(acct,space,A.allow.app,[A.allow.project]);msg(r.summary+". Approving this one…");await ok.onclick()}
catch(e){alw.disabled=false;msg(/sign in/.test(e.message)?"Sign in on /start in this browser first, then try again (or just Approve).":"Permission not saved: "+e.message)}};
if(reg)reg.onclick=async()=>{try{const c=await navigator.credentials.create({publicKey:{challenge:enc(A.challenge),rp:{id:location.hostname,name:"Kitebook"},user:{id:crypto.getRandomValues(new Uint8Array(16)),name:A.name,displayName:"Kitebook owner ("+A.name+")"},
pubKeyCredParams:[{type:"public-key",alg:-7},{type:"public-key",alg:-8},{type:"public-key",alg:-257}],authenticatorSelection:{residentKey:"preferred",userVerification:"required"},attestation:"none",timeout:120000}});
send({credential:{id:c.id,publicKey:b64u(c.response.getPublicKey()),alg:c.response.getPublicKeyAlgorithm(),clientDataJSON:b64u(c.response.clientDataJSON)}})}catch(e){msg("Passkey not created: "+e.message)}};
</script></body></html>`;
}
