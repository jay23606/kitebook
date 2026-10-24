// GET /settings: one page for everything the owner can change, by click, in plain words, on a phone or a desktop (system dark mode).
//   Connection         the public address + the Claude.ai/ChatGPT link (Copy); with no server/domain the built-in tunnel's health, Restart
//                      tunnel, and an optional Cloudflare tunnel token for an address that never changes (client/tunnel.ts on the Mac applies it)
//   Run tasks without asking  ONE top-level switch (+ Turn off after: never / 8 h / 24 h / 7 days), signed in this browser into the owner's
//                      policy (client/payload.ts autorunOn); a banner with Turn off while it's on. Per-app rules (projects an app runs on
//                      its own in) are the advanced knob, folded under each app's Change.
//   Experimental       (More) one switch for not-yet-stable features, each with its own switch: Test every push (local CI, client/ci.ts),
//                      Show test results on GitHub; the latest test runs and recent errors. It changes no permission.
//   Instructions       "Instructions for your assistants" (src/brief.ts): one text box per workspace that every connected assistant gets
//                      (MCP initialize, describe, task_create's brief etag); Save, Undo (puts the previous version back from the file's history),
//                      older versions, and the apps' suggestions (brief_propose) to Accept or Dismiss. Secrets are replaced on save, with a warning.
//   Coding agents      per Mac: the coding agents it found (Pi, Codex, Claude Code, Cursor, Gemini CLI, opencode, GitHub Copilot CLI, Grok
//                      CLI), each with one-click Connect (the Mac wires it to Kitebook, client/agents-connect.ts) and what it can do there; and
//                      which agent works on each project (runner.json prefs.byProject, signed like every Mac change)
//   Connected apps     each app: what it can do (Just its folder / Its folder + send tasks / Read only), which folder, the projects it may
//                      run tasks on its own in, how long it keeps access (1, 7, 30 days or no end date), Remove
//   Devices & passkeys computers (devices: approve / revoke), browsers signed in, passkeys, sign-ins waiting, and which browsers your Mac trusts (Trust / Forget, by click)
//   Approvals          where you approve: a signed-in browser, your Mac (dialog, Terminal), and your phone as an optional extra
//   Updates            per Mac: the release it runs vs the newest signed one, Update now, "Install signed updates automatically" (off by
//                      default), who asked for an update (agents' relay_update) and what happened (client/updater.ts on the Mac decides).
//                      A git checkout (the one-step install, scripts/get.sh): the version vs main (stable), Update now for every owner,
//                      Update to dev now with Experimental on, "Install updates automatically" (client/git-channel.ts)
//   Releases           the release key installs check, and a release key made on your Mac (Create / Copy); the private half never leaves it
//   Recovery           passkey or kitebook open, plus an optional printable recovery code
// The page reads and writes through POST /start (same session, a one-time nonce per change). App access and expiry are server-side; what
// lives on the Mac (trust, phone, release key) is a change signed in this browser (policy-ui.ts OWN.cmd) that the Mac checks against the
// browsers it trusts (client/settings-sync.ts). No user text is ever put into the page as HTML.
import { isRoot, ROOT_ACCOUNT } from "../client/account.ts";
import { PRESENCE_JS } from "./presence-ui.ts";
import { PAGE_HEADERS, esc } from "./approve.ts";
import { OWNER_JS } from "./policy-ui.ts";
import { PASSKEY_JS } from "./auth.ts";

export const settingsHeaders = PAGE_HEADERS;
// the shared look (src/ui.ts): THEME_CSS is re-exported for older imports
import { THEME_CSS, BASE_CSS, FOLD_CSS, FOLD_JS } from "./ui.ts";
export { THEME_CSS };

export function settingsPage(s: { acct: string; origin: string; release: string }, nonce: string) {
  // a section under More: one more fold, its label and a one-line summary (owner, 22:41: "short and meaningful"), the box inside
  const sec = (id: string, title: string, body = "") => `<details class="fold sub" id="${id}"><summary class="srow"><span>${title}</span><span class="v" id="${id}-n"></span></summary><div class="fb" id="${id}-box">${body || `<p class="note">Loading…</p>`}</div></details>`;
  // a top-level row that opens: label left, a count right; the fold holds the whole section
  const fold = (id: string, label: string, body: string) => `<details class="fold" id="${id}"><summary class="srow"><span>${label}</span><span class="v" id="${id}-n"></span></summary><div class="fb">${body}</div></details>`;
  const data = JSON.stringify(s).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta name="color-scheme" content="light dark"><title>Kitebook settings</title>
<style>${THEME_CSS}${BASE_CSS}${FOLD_CSS}
/* Settings (owner, 2026-10-22: "absolutely short"): one list of rows, label left and a value, toggle or count right; Connected apps and
   Signed-in devices open in place; everything else under one More. /settings#<section> opens the fold it's in; #all opens every fold. */
body{max-width:640px;margin:0 auto;padding:0 20px 96px}
header{display:flex;align-items:center;gap:16px;padding:16px 0 12px}header h1{font-size:24px;margin:0;flex:1}header a{color:var(--mut);text-decoration:none;font-size:16px}
.srow,.trow{display:flex;align-items:center;gap:12px;min-height:60px;padding:6px 0;border-top:1px solid var(--line);font-size:17px}.list>:first-child,.list>:first-child>.srow{border-top:0}
.srow>span:first-child,.trow>span:first-child{flex:1;min-width:0}.v{color:var(--mut);font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:60%}
details.fold>summary.srow::before{display:none}details.fold>summary.srow::after{content:"›";color:var(--mut);font-size:22px;transition:transform .12s}details.fold[open]>summary.srow::after{transform:rotate(90deg)}
.fb{padding:0 0 16px}.trow input[type=checkbox]{width:44px;height:26px;appearance:none;-webkit-appearance:none;border-radius:13px;background:var(--line);position:relative;cursor:pointer;flex:none;border:0;transition:background .12s}
.trow input[type=checkbox]::after{content:"";position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;transition:left .12s;box-shadow:0 1px 3px rgba(0,0,0,.3)}.trow input:checked{background:var(--acc)}.trow input:checked::after{left:21px}
.trow button{min-height:40px;padding:8px 16px;font-size:15px}.trow .v{max-width:55%}.danger-line{color:var(--danger);font-size:15px;margin:-4px 0 8px}
details#moreset{margin-top:0}details#moreset>summary{border-top:1px solid var(--line)}details#moreset>summary>span:first-child{color:var(--mut)}
details.sub{scroll-margin-top:16px}details.sub>summary.srow{min-height:52px;font-size:16px}details.sub>.fb{padding:0 0 16px 12px}#moreset>.fb>p.note:first-child{margin:0 0 4px}
details.sub h3{font-size:15px;color:var(--mut);margin:16px 0 4px;font-weight:600}
.note{font-size:15px;margin:4px 0 8px}.now{margin:6px 0 2px}
.app,.item{border-top:1px solid var(--line);padding:12px 0}.app:first-child,.item:first-child{border-top:0}
.ah{display:flex;gap:4px 10px;align-items:baseline;flex-wrap:wrap}.ah b{font-size:17px}.tag{font-size:15px;color:var(--mut)}.tag::before{content:"· "}.tag.ok{color:var(--acc);font-weight:600}.tag.warn{background:none;border:0;padding:0;margin:0;color:var(--danger);font-weight:600}
button{background:var(--acc);color:var(--onacc)}button:hover{background:var(--acc2)}
button.sec{background:var(--soft);color:var(--fg)}button.sec:hover{background:var(--line)}button.danger{background:none;color:var(--danger)}button.danger:hover{background:var(--soft)}button.danger.sure{background:var(--danger);color:var(--bg)}
.bar{display:flex;gap:12px;flex-wrap:wrap;margin-top:12px}.bar button{flex:1 1 160px}
details.chg>summary{display:inline-flex;margin-top:4px;color:var(--link);font-size:16px;min-height:40px}details.chg[open]>summary{margin-bottom:8px}
details.log{margin-top:12px}details.log>summary{color:var(--mut);font-size:15px}.form{padding:4px 0 8px 20px;border-left:2px solid var(--line)}
.choice{display:flex;gap:12px;align-items:flex-start;padding:10px 0;border-top:1px solid var(--line);cursor:pointer}.choice:first-of-type{border-top:0}.choice input{margin-top:3px;flex:none}
.choice b{display:block;font-weight:600}.choice small{display:block;color:var(--mut);font-size:15px}.choice:has(input:checked) b{color:var(--acc)}
label.f{display:block;margin:12px 0 6px;font-size:15px;color:var(--mut)}textarea{font:15px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical}
pre.sug{max-height:320px;overflow:auto;font-size:14px}label.chk{display:flex;gap:12px;align-items:center;padding:8px 0}
.code{display:flex;gap:8px;align-items:center;margin:8px 0}.code pre{flex:1;min-width:0;word-break:break-all}.code button{flex:none;min-height:44px;padding:10px 16px;font-size:15px}
.row{display:flex;justify-content:space-between;gap:8px 16px;align-items:center;flex-wrap:wrap;padding:12px 0;border-top:1px solid var(--line)}.row:first-child{border-top:0}.row small{display:block;color:var(--mut);font-size:15px}.row button{min-height:40px;padding:8px 14px;font-size:15px}
#msg{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);max-width:min(92vw,600px);background:var(--fg);color:var(--bg);padding:12px 18px;border-radius:12px;font-size:16px;font-weight:600;box-shadow:0 6px 24px rgba(0,0,0,.22);z-index:9}#msg:empty{display:none}
.devbar{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.devbar button{min-height:40px;padding:8px 14px;font-size:15px}
label.sw{display:flex;gap:14px;align-items:center;padding:8px 0;font-size:17px;font-weight:600}
@media (max-width:560px){.code{flex-wrap:wrap}.code pre{flex-basis:100%}}
@media print{header,.list,#todo,details#moreset>summary,details.sub:not(#recovery),#recovery>summary,button{display:none}details#moreset>*{display:block}}
</style></head><body>
<header><h1>Settings</h1><a href="/start">← Home</a></header>
<div id="autorunbanner" class="warn devbar" role="status" hidden></div><div id="todo"><div id="todo-d"></div><div id="todo-u"></div></div>
<div class="list">
<div class="trow" id="addr"><span>Address</span><span class="v" id="addr-v">…</span></div><p class="danger-line" id="addr-warn" hidden>This address only works on this computer.</p>
${fold("apps", "Connected apps", `<div id="agents-box"></div><div id="apps-box"><p class="note">Loading…</p></div>`)}
<div id="autorunrows"></div><div id="updrows"></div>
${fold("devices", "Signed-in devices", `<div id="devices-box"><p class="note">Loading…</p></div>`)}
</div>
<details id="moreset" class="fold"><summary class="srow"><span>More</span><span class="v" id="moreset-n">Connection, approvals, updates, recovery</span></summary><div class="fb">
<p class="note">${isRoot(s.acct) ? "Signed in as the owner" : `Signed in to <b>${esc(s.acct)}</b>`}<span id="server-build"></span></p>
${sec("connection", "Connection")}
${sec("brief", "Instructions for your assistants")}
${sec("approvals", "Approvals")}
${sec("remotepw", "Approve from other devices")}
${sec("experimental", "Experimental")}
${sec("trust", "Passkeys and browsers")}
${sec("updates", "Updates")}
${sec("releases", "Releases")}
${sec("recovery", "Recovery", `<p class="note">Sign in with a passkey, or run <code>kitebook open</code> on your Mac. A printable recovery code is optional; a new one replaces the old.</p>
<div class="bar"><button id="rcnew" class="sec">Make a recovery code</button></div><div id="rcout" hidden><div class="code"><pre id="rcode"></pre><button id="rccopy" class="sec">Copy</button></div><div class="bar"><button id="rcprint" class="sec">Print</button></div></div>`)}
</div></details><p id="msg" role="status" aria-live="polite"></p>
<script id="st" type="application/json">${data}</script>
<script nonce="${nonce}">
${FOLD_JS}
${OWNER_JS}
${PASSKEY_JS}
{const mo=()=>{const h=location.hash.slice(1).split(",").filter(Boolean),all=h.includes("all");let first=null;
for(const d of document.querySelectorAll("details.fold"))if(all)d.open=true;for(const k of h){let e=document.getElementById(k);if(!e)continue;first=first||e;for(let p=e;p;p=p.parentElement)if(p.matches&&p.matches("details.fold"))p.open=true}if(first&&!all)first.scrollIntoView()};mo();addEventListener("hashchange",mo)} /* /settings#apps, #approvals, #releases…: open the fold it's in; #all opens every fold */
const S=JSON.parse(document.getElementById("st").textContent),$=id=>document.getElementById(id),AB=S.acct===${JSON.stringify(ROOT_ACCOUNT)}?"/api/auth":"/u/"+S.acct+"/api/auth";
let mt=0;const msg=t=>{$("msg").textContent=t;clearTimeout(mt);if(t)mt=setTimeout(()=>{$("msg").textContent=""},12000)};
${PRESENCE_JS}
const post=async b=>{const r=await withPresence(()=>fetch("/start",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b)}));return await r.json()};
const nonce=async()=>{const n=await post({op:"nonce"});if(!n.ok)throw new Error(n.error);return n.result.nonce};
/* each fold's one-line summary (.v in its header): names and states, not counts, so the closed page already says what is there */
const sumv=(id,t)=>{const e=$(id+"-n");if(e)e.textContent=t},names=(xs,n=3)=>xs.length?xs.slice(0,n).join(", ")+(xs.length>n?" +"+(xs.length-n):""):"";
const el=(t,c,x)=>{const e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e};
const btn=(label,cls,fn)=>{const b=el("button",cls,label);b.type="button";b.onclick=async()=>{b.disabled=true;try{await fn(b)}catch(e){msg(e.message)}finally{b.disabled=false}};return b};
const copyText=async t=>{try{await navigator.clipboard.writeText(t);return true}catch(e){}try{const a=document.createElement("textarea");a.value=t;a.style.position="fixed";a.style.opacity="0";document.body.append(a);a.select();const ok=document.execCommand("copy");a.remove();return ok}catch(e){return false}};
const codeBox=(text,label)=>{const c=el("div","code");c.append(el("pre","",text),btn(label||"Copy","sec",async b=>{if(await copyText(text)){b.textContent="Copied";msg("Copied")}else msg("Select the text and copy it by hand")}));return c};
const DAY=86400000,day=ms=>new Date(ms).toLocaleDateString([],{month:"short",day:"numeric"});
const kindLabel=k=>({coding_agent:"Coding agent",assistant:"Assistant",runner:"Your Mac"})[k]||"App";
const W=g=>g==="**"?"every folder":g.replace(/\\/\\*\\*$/,"");
const own=a=>a.paths.filter(g=>!/^[a-z]+:/.test(g));
const folderOf=a=>{const p=own(a);return p.length===1&&p[0]!=="**"&&a.verbs.includes("write")&&!a.verbs.includes("delete")&&p.length===a.paths.length?W(p[0]):null};
const presetOf=a=>{const send=a.verbs.includes("dispatch"),v=a.verbs.filter(x=>x!=="dispatch").join(",");if(v==="read"&&a.paths.join()==="**")return send?"custom":"read";if(v==="read,write"&&a.paths.join()==="**,write:shared/**,write:kb/**")return send?"shared":"custom";return folderOf(a)?(send?"tasks":"folder"):"custom"};
const live=e=>!!(e&&e.tasks==="auto"&&(!e.until||e.until>Date.now()));
const canDo=a=>{const p=own(a).map(W),wr=a.paths.filter(g=>g.startsWith("write:")).map(g=>W(g.slice(6)));let t;
if(p.includes("every folder"))t=a.verbs.includes("delete")?"It can read, edit and delete everything.":a.verbs.includes("write")?"It can read everything and edit "+(wr.length?wr.join(" and "):"everything")+".":"It can read every folder and change nothing.";
else t=a.verbs.includes("write")?"It can read and edit "+(p.join(", ")||"no folder")+".":"It can read "+(p.join(", ")||"no folder")+".";return t};
const taskWords=(a,e)=>!a.verbs.includes("dispatch")?"It can't send tasks.":arAny()&&!live(e)?"It can send tasks; they run without asking (Run tasks without asking is on).":live(e)?"It runs tasks in "+e.projects.join(", ")+" on its own; pushing still asks you.":"It can send tasks; you approve each one.";
const expWords=a=>a.expires?(a.expires>Date.now()?"Access ends "+day(a.expires)+".":"Access ended "+day(a.expires)+". Pick how long below to turn it back on."):"Access has no end date.";
let ST=null,ME=null,MEERR="",DV=null,MC=null,JN=null;const pending=new Map();
/* More -> Approve from other devices: the master password typed on a phone, checked by the Mac (src/remote-pw.ts); either way needs presence */
async function loadRpw(){const x=await post({op:"remote_pw"});const box=$("remotepw-box");if(!x.ok)return box.replaceChildren(el("p","warn",x.error));const r=x.result;sumv("remotepw",r.on?"On":"Off");
const l=el("label","sw"),c=document.createElement("input");c.type="checkbox";c.id="rpwsw";c.checked=r.on;l.append(c,el("span","","Approve from other devices with my password"));
c.onchange=async()=>{c.disabled=true;try{const y=await post({op:"remote_pw_set",on:c.checked,nonce:await nonce()});if(!y.ok)throw new Error(y.error);msg(c.checked?"On: a phone can approve with your master password; your Mac checks it.":"Off: approve on your Mac only.");}catch(e){c.checked=!c.checked;msg(e.message)}finally{c.disabled=false;loadRpw().catch(()=>{})}};
const out=[l,el("p","note","On a phone or another computer, type your master password on the approval page: it goes over HTTPS to your Mac, which checks it and forgets it. Nothing stores it. 5 wrong tries lock this for 15 minutes.")];
{const pa=el("p","note","Or approve from a phone with its own PIN, fingerprint or face: open this on the phone and add a passkey (you approve it once): ");const lk=el("a","",location.origin+"/device?add=passkey"+(S.acct===${JSON.stringify(ROOT_ACCOUNT)}?"":"&account="+S.acct));lk.href=lk.textContent;pa.append(lk);out.push(pa)}
if(r.locked_until)out.push(el("p","warn","Locked after too many wrong passwords until "+new Date(r.locked_until).toLocaleTimeString()+"."));
if(r.log&&r.log.length)out.push(el("p","note","Recent: "+r.log.slice(0,5).map(e=>new Date(e.at).toLocaleTimeString()+" "+e.kind.replace("_"," ")).join(" · ")));box.replaceChildren(...out)}
async function load(){loadConn().catch(()=>{});loadRpw().catch(e=>$("remotepw-box").replaceChildren(el("p","warn",e.message)));loadBrief().catch(e=>$("brief-box").replaceChildren(el("p","warn",e.message)));try{ST=await OWN.read()}catch(e){return ["experimental","agents","apps","devices","trust","approvals","updates","releases"].forEach(x=>$(x+"-box").replaceChildren(el("p","warn",e.message)))}
try{ME=await OWN.ready(S.acct,ST.owner_keys);ST=await OWN.read()}catch(e){ME=null;MEERR=e.message}
DV=await post({op:"devices"});MC=await post({op:"machines"}).catch(()=>null);JN=await post({op:"joins"}).catch(()=>null);render()}
const runners=()=>ST.spaces.flatMap(sp=>sp.runners.map(r=>({...r,space:sp.space})));
const trustedBy=fp=>runners().filter(r=>(r.owner_keys||[]).includes(fp));
const meTrusted=()=>!!ME&&runners().some(r=>(r.owner_keys||[]).includes(ME.fp));
function render(){sumv("recovery","Passkey or kitebook open");renderAutorun();renderExperimental();renderAgents();renderApps();renderDevices();renderApprovals();renderUpdates();renderReleases();
sumv("apps",names([...new Set(ST.spaces.flatMap(sp=>sp.apps.filter(a=>a.kind!=="human").map(a=>a.name)))])||"None yet")} /* the top-level summaries */
// ---- Run tasks without asking (OWN.autorun; legacy policy.dev reads as it) ----
const pol=sp=>sp.envelope&&sp.envelope.policy||{};
const arOf=sp=>{const p=pol(sp),d=p.autorun||p.dev;return d&&d.on&&(!d.until||d.until>Date.now())?d:null};
const arAny=()=>ST.spaces.some(sp=>arOf(sp));
const exOf=sp=>sp.experimental||null,exAny=()=>ST.spaces.some(sp=>exOf(sp));
const UNTIL={never:0,h8:8*3600000,h24:24*3600000,d7:7*DAY};
function autorunBanner(){const b=$("autorunbanner"),on=ST.spaces.filter(sp=>arOf(sp));b.hidden=!on.length;if(!on.length)return b.replaceChildren();
const u=on.map(sp=>arOf(sp).until).filter(Boolean),off=btn("Turn off","sec",async()=>{for(const sp of on)await OWN.autorun(S.acct,sp.space,false);msg("Tasks ask you again.");await load()});off.id="autorunoff";
b.replaceChildren(el("span","","Running your apps' tasks without asking"+(u.length?" until "+when(Math.min(...u)):"")+"."),off)}
function renderAutorun(){autorunBanner();const top=$("autorunrows"),rows=[],many=ST.spaces.length>1;
for(const sp of ST.spaces){const d=arOf(sp);
const L=el("label","trow"),i=document.createElement("input");i.type="checkbox";i.id=many?"autoruntoggle-"+sp.space:"autoruntoggle";i.checked=!!d;L.append(el("span","","Run tasks without asking"+(many?" in "+sp.space:"")),i);rows.push(L);
const xl=el("label","f","Turn off after"),xs=document.createElement("select");xs.id=many?"autorununtil-"+sp.space:"autorununtil";xl.htmlFor=xs.id;
for(const[v,t]of[["never","Never"],["h8","8 hours"],["h24","24 hours"],["d7","7 days"]]){const o=el("option","",t);o.value=v;xs.append(o)}
const save=async on=>{const ms=UNTIL[xs.value]||0;const r=await OWN.autorun(S.acct,sp.space,on,on&&ms?Date.now()+ms:null);msg(on?"Your apps' tasks start without asking. "+(ms?"This turns itself off "+when(Date.now()+ms)+".":"Until you turn it off."):"Tasks ask you again.");await load();return r};
i.onchange=async()=>{const on=i.checked;i.disabled=true;try{await save(on)}catch(e){i.checked=!on;msg(e.message)}finally{i.disabled=false}};
xs.onchange=async()=>{if(!i.checked)return;try{await save(true)}catch(e){msg(e.message)}};
if(d){const w=el("div","item");w.append(el("p","danger-line","On"+(d.until?" until "+when(d.until):"")+": your apps' tasks start without asking you."),xl,xs,el("p","note","Still asks for: people you invited, your other Macs, removed apps, pushing to main, and anything that can't be undone."));
if(!meTrusted()&&runners().length)w.append(el("p","warn","Your Mac doesn't trust this browser yet, so it keeps asking until you trust it (see Passkeys and browsers)."));rows.push(w)}}
top.replaceChildren(...rows)}
// ---- Experimental (OWN.experimental): features only ----
const sw2=(id,label,on,fn)=>{const L=el("label","trow"),i=document.createElement("input");i.type="checkbox";i.id=id;i.checked=on;L.append(el("span","",label),i);
i.onchange=async()=>{const v=i.checked;i.disabled=true;try{await fn(v)}catch(e){i.checked=!v;msg(e.message)}finally{i.disabled=false}};return L};
const ciLine=c=>(c.state==="passed"?"✓ ":c.state==="failed"?"✗ ":"")+c.project+(c.branch?" "+c.branch:"")+" · "+(c.passed!=null?c.passed+" passed"+(c.failed?", "+c.failed+" failed":""):c.state)+(c.secs!=null?" · "+c.secs+" s":"")+" · "+when(c.at);
function renderExperimental(){const box=$("experimental-box"),out=[],many=ST.spaces.length>1;sumv("experimental",exAny()?"On":"Off");
for(const sp of ST.spaces){const x=exOf(sp),id=k=>many?k+"-"+sp.space:k,set=v=>OWN.experimental(S.acct,sp.space,v).then(r=>{msg(r.summary+".");return load()});if(many)out.push(el("h3","","Workspace "+sp.space));
out.push(sw2(id("exptoggle"),"Experimental",!!x,v=>set(v?{ci:true}:null)),el("p","note","Features that aren't finished yet. Changes no permission."));
if(!x)continue;
out.push(sw2(id("expci"),"Test every push",x.ci!==false,v=>set({ci:v,gh_status:x.gh_status})),sw2(id("expgh"),"Show test results on GitHub",!!x.gh_status,v=>set({ci:x.ci,gh_status:v})));
const cs=sp.ci||[],w=el("div","log");w.id=id("cilist");w.append(el("h3","","Tests"));if(!cs.length)w.append(el("p","note","No runs yet. Projects need a test command."));for(const c of cs.slice(0,5))w.append(el("p","note",ciLine(c)));out.push(w);
const re=el("div","log");re.id=id("experrs");re.append(el("h3","","Recent errors"));const es=sp.recent_errors||[];
if(!es.length)re.append(el("p","note","No errors lately."));for(const e of es)re.append(el("p","note",when(Date.parse(e.at))+" · "+e.source+(e.route?" · "+e.route+(e.status?" "+e.status:""):"")+": "+e.msg+(e.request_id?" ("+e.request_id+")":"")));out.push(re)}
box.replaceChildren(...out)}
// ---- connected apps ----
const choice=(name,val,title,sub,checked)=>{const L=el("label","choice"),i=document.createElement("input");i.type="radio";i.name=name;i.value=val;i.className="preset";i.checked=checked;const t=el("span");t.append(el("b","",title),el("small","",sub));L.append(i,t);return [L,i]};
function renderApps(){const box=$("apps-box"),out=[];
for(const sp of ST.spaces){if(ST.spaces.length>1)out.push(el("h3","","Workspace "+sp.space));const pol=sp.envelope?sp.envelope.policy:null,apps=sp.apps.filter(a=>a.kind!=="human");
if(!apps.length)out.push(el("p","note","No assistant or coding agent is connected yet. Connect one from Get started."));
for(const a of apps)out.push(appCard(sp,a,pol?pol.apps[a.name]:null));
if(sp.log.length){const d=el("details","log"),s=el("summary","","Recent changes ("+sp.log.length+")");d.append(s);d.open=true;/* the audit list: each change in one line, with Undo */
for(const l of sp.log.slice(0,15)){const r=el("div","row"),t=el("div");t.append(el("span","",l.summary+(l.undone_by?" (undone)":"")),el("small","",new Date(l.at).toLocaleString([],{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"})));r.append(t);
const swk=l.switch||(l.dev?"autorun":null);
if(swk&&!l.undone_by&&!l.undo_of)r.append(btn("Undo","sec undo",async()=>{const pd=swk==="autorun"?(l.prev.autorun||l.prev.dev):l.prev.experimental;const x=swk==="autorun"?await OWN.autorun(S.acct,sp.space,!!pd,pd?pd.until:null,l.id):await OWN.experimental(S.acct,sp.space,pd?{ci:pd.ci,gh_status:pd.gh_status}:null,l.id);msg(x.summary+".");await load()}));
else if(!l.refused&&!swk&&!l.undone_by&&!l.undo_of)r.append(btn("Undo","sec undo",async()=>{const x=await OWN.set(S.acct,sp.space,l.app,l.prev.entry,l.prev.caps?{mode:"raw",verbs:l.prev.caps.verbs,paths:l.prev.caps.paths}:null,l.id);msg(x.summary+".");await load()}));d.append(r)}out.push(d)}}
out.push(addApp());box.replaceChildren(...out)}
// Add an app (connect-any-app): for an assistant that only has an API-key field (Muse...): a name, what it can do, how long -> a key shown
// once plus the prompt to paste into the app (it asks for the key through its own secure credential prompt). Remove ends it like any app.
let ADDED=null;
function addApp(){const d=el("details","log add");d.id="add-app";d.open=!!ADDED;d.append(el("summary","","Add an app (an assistant that only takes an API key)"));
if(ADDED){const k=el("pre","",ADDED.key),pr=el("pre","",ADDED.prompt);k.id="add-key";pr.id="add-prompt";
d.append(el("p","now","Added "+ADDED.peer+" ("+ADDED.access+"). Its key is shown only now:"),k,btn("Copy key","sec",async()=>{await navigator.clipboard.writeText(ADDED.key);msg("Key copied. Paste it only into the app's secure credential prompt.")}),
el("p","note","Paste this into the app; it asks you for the key through its secure credential prompt:"),pr,btn("Copy prompt","sec",async()=>{await navigator.clipboard.writeText(ADDED.prompt);msg("Prompt copied.")}),btn("Done","sec",async()=>{ADDED=null;renderApps()}));return d}
const nl=el("label","f","Its name, for example Muse"),ni=document.createElement("input");ni.type="text";ni.id="add-name";nl.htmlFor=ni.id;ni.setAttribute("autocapitalize","off");d.append(nl,ni);const ch={};
for(const[v,t,s]of[["tasks","Read everything, save to shared memory, send tasks (recommended)","Saves only in shared/ and kb/. You approve each task it sends."],["folder","Its own folder + send tasks","Reads and edits only kb/<its name>."],["read","Read only","Changes nothing, sends nothing."]]){const[L,i]=choice("add-acc",v,t,s,v==="tasks");ch[v]=i;d.append(L)}
const xl=el("label","f","How long it keeps access"),xs=document.createElement("select");xs.id="add-exp";xl.htmlFor=xs.id;for(const[v,t]of[["0","No end date"],["1","1 day"],["7","7 days"],["30","30 days"]]){const o=el("option","",t);o.value=v;xs.append(o)}d.append(xl,xs);
const go=btn("Add and show its key","save",async()=>{const name=ni.value.trim();if(!name)throw new Error("Type a name, for example Muse");const r=await post({op:"app_add",name,choice:Object.keys(ch).find(k=>ch[k].checked),days:+xs.value||null,nonce:await nonce()});if(!r.ok)throw new Error(r.error);ADDED=r.result;msg("Added "+r.result.peer+". Copy its key now: it isn't shown again.");await load()});go.id="add-go";d.append(go);return d}
function appCard(sp,a,e){const w=el("div","app");w.id="app-"+a.name;const h=el("div","ah");h.append(el("b","",a.name),el("span","tag",kindLabel(a.kind)));if(a.never_connected)h.append(el("span","tag","not connected yet"));if(a.expires&&a.expires<=Date.now())h.append(el("span","tag warn","access ended"));
w.append(h,el("p","now",canDo(a)+" "+taskWords(a,e)),el("p","note",expWords(a)));
if(e&&(e.sessions==="read"||e.sessions==="write")){const n=el("p","note sess-now",e.sessions==="write"?"It can search, read and continue your agent sessions (your own ones only as a copy).":"It can search and read your agent sessions.");n.id="sess-now-"+a.name;w.append(n);
const lg=(sp.sessions_log||[]).filter(x=>x.app===a.name).slice(0,5);for(const x of lg)w.append(el("p","note",when(Date.parse(x.at))+" · "+x.op+(x.agent?" "+x.agent:"")+(x.id?" "+x.id:"")))}
const d=el("details","chg"),f=el("div","form"),cur=presetOf(a),nm="p-"+sp.space+"-"+a.name;d.append(el("summary","","Change"),f);
f.append(el("h3","","What it can do"));const ch={};
for(const[v,t,s]of[["shared","Read everything, save to shared memory, send tasks (recommended)","Saves only in shared/ and kb/ (where kb_add writes). Sends tasks to your Mac; you approve each one, unless you pick projects below."],["folder","Just its folder","Reads and edits one folder. It can't send tasks."],["tasks","Its folder + send tasks","Also sends tasks to your Mac. You approve each one, unless you pick projects below."],["read","Read only","Reads every folder and changes nothing. It can't send tasks."]]){const[L,i]=choice(nm,v,t,s,cur===v);ch[v]=i;f.append(L)}
if(cur==="custom"){const[L,i]=choice(nm,"custom","Keep as it is",canDo(a)+" "+taskWords(a,e),true);ch.custom=i;f.append(L)}
const fl=el("label","f","Folder it uses");const fi=document.createElement("input");fi.type="text";fi.className="fl";fi.value=folderOf(a)||("kb/"+a.name);fi.setAttribute("autocapitalize","off");fl.htmlFor=fi.id="fl-"+a.name;
const pj=el("details","pjs log");pj.open=live(e);pj.append(el("summary","","Advanced: let it run tasks on its own in chosen projects"),el("p","note","Leave them all unticked to approve each task (or turn on Run tasks without asking at the top for all your apps)."));
if(!sp.projects.length)pj.append(el("p","note","No projects yet: your Mac lists them once it's connected."));
for(const p of sp.projects){const L=el("label","chk"),i=document.createElement("input");i.type="checkbox";i.className="pj";i.value=p;i.checked=live(e)&&e.projects.includes(p);L.append(i,el("span","",p));pj.append(L)}
const xl=el("label","f","How long it keeps access"),xs=document.createElement("select");xs.className="exp";xs.id="exp-"+a.name;xl.htmlFor=xs.id;
for(const[v,t]of[["keep",a.expires?(a.expires>Date.now()?"Keep: until "+day(a.expires):"Keep: ended "+day(a.expires)):"Keep: no end date"],["1","1 day from now"],["7","7 days from now"],["30","30 days from now"],["0","No end date"]]){const o=el("option","",t);o.value=v;xs.append(o)}
const sync=()=>{const p=Object.keys(ch).find(k=>ch[k].checked);fl.hidden=fi.hidden=!(p==="folder"||p==="tasks");pj.hidden=!(p==="tasks"||p==="shared"||(p==="custom"&&a.verbs.includes("dispatch")))};Object.values(ch).forEach(i=>i.onchange=sync);sync();
/* Agent sessions (live-sessions): may it search/read, or also continue, your own coding-agent sessions on your computers? Off by default */
const sl=el("label","f","Your agent sessions (Codex, Claude Code, Pi... on your computers)"),ss=document.createElement("select");ss.className="sess";ss.id="sess-"+a.name;sl.htmlFor=ss.id;
for(const[v,t]of[["off","Off: it can't see them"],["read","Search and read (read-only)"],["write","Search, read and send (continues a copy; in place asks you)"]]){const o=el("option","",t);o.value=v;o.selected=(e&&e.sessions||"off")===v;ss.append(o)}
f.append(sl,ss);const sv=btn("Save","save",()=>saveApp(sp,a,e,ch,fi,pj,xs,ss));sv.id="save-"+a.name;
const rm=btn("Remove","danger rm",async b=>{if(!b.classList.contains("sure")){b.classList.add("sure");b.textContent="Yes, remove "+a.name;setTimeout(()=>{b.classList.remove("sure");b.textContent="Remove"},6000);return}
const r=await post({op:"revoke",peer:a.name});if(!r.ok)throw new Error(r.error);msg(a.name+" is removed. Its sign-in stopped working.");await load()});rm.id="rm-"+a.name;
const bar=el("div","bar");bar.append(sv,rm);f.append(fl,fi,pj,xl,xs,bar);w.append(d);return w}
async function saveApp(sp,a,e,ch,fi,pj,xs,ss){const p=Object.keys(ch).find(k=>ch[k].checked),said=[];
if(ss&&ss.value!==((e&&e.sessions)||"off")){const r=await OWN.sessions(S.acct,sp.space,a.name,ss.value);said.push(r.summary)}
const folder=fi.value.trim().replace(/^\\/+|\\/+$/g,""),projects=[...pj.querySelectorAll("input.pj:checked")].map(i=>i.value).sort();
const cur=presetOf(a),curF=folderOf(a),curP=live(e)?[...e.projects].sort():[];
const changed=p!=="custom"&&(p!==cur||((p==="folder"||p==="tasks")&&folder!==curF)||((p==="tasks"||p==="shared")&&projects.join()!==curP.join()));
if(p==="custom"&&a.verbs.includes("dispatch")&&projects.join()!==curP.join()){/* keep its folders, change only where it runs tasks on its own */
const entry=projects.length?{tasks:"auto",projects,push:!!(live(e)&&e.push),until:live(e)?e.until||null:null,keys:e&&e.tasks==="auto"&&e.keys&&e.keys.length?e.keys:[await OWN.appKey(sp.space,a.name)]}:null;
const r=await OWN.set(S.acct,sp.space,a.name,entry,null);said.push(r.summary)}
if(changed){if((p==="folder"||p==="tasks")&&!folder)throw new Error("Type the folder it uses, for example kb/"+a.name);
const access=p==="read"?{mode:"read"}:p==="shared"?{mode:"shared"}:{mode:"folders",folders:[folder]};let entry=null;
if(p!=="tasks"&&p!=="shared")entry={tasks:"off",projects:[],push:false,until:null,keys:[]};
else if(projects.length)entry={tasks:"auto",projects,push:!!(live(e)&&e.push),until:null,keys:e&&e.tasks==="auto"&&e.keys&&e.keys.length?e.keys:[await OWN.appKey(sp.space,a.name)]};
const r=await OWN.set(S.acct,sp.space,a.name,entry,access);said.push(r.summary)}
if(xs.value!=="keep"){const d=+xs.value,r=await post({op:"app_expiry",app:a.name,days:d||null,nonce:await nonce()});if(!r.ok)throw new Error(r.error);said.push(d?a.name+" keeps access until "+day(r.result.expires):a.name+" keeps access with no end date")}
msg(said.length?"Saved. "+said.join(". ")+".":"Nothing changed.");await load()}
// ---- devices & passkeys ----
const enc=t=>new TextEncoder().encode(t),b64u=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"");
const act=async(b,ok)=>{const x=await post({...b,nonce:await nonce()});if(!x.ok)throw new Error(x.error);msg(ok);await load()};
const macCmd=async(c,ok)=>{const sp=ST.spaces[0].space,r=await OWN.cmd(S.acct,sp,c,ST.owner_keys);pending.set(r.id,ok);msg("Sent to your Mac. It applies it within a few seconds.");watch()};
let wt=0;function watch(){clearTimeout(wt);let n=0;const tick=async()=>{n++;try{ST=await OWN.read()}catch(e){return}
for(const r of runners())for(const d of(r.settings&&r.settings.done)||[])if(pending.has(d.id)){const ok=pending.get(d.id);pending.delete(d.id);msg(d.ok?(ok==="@"?r.name+": "+d.msg+".":ok):r.name+" didn't do it: "+d.msg)}
render();if(pending.size&&n<40)wt=setTimeout(tick,2000)};wt=setTimeout(tick,1500)}
function renderDevices(){const box=$("devices-box"),out=[],todo=[],tr=[],R=DV&&DV.ok?DV.result:{devices:[],passkeys:[],logins:[]};
/* kitebook join: a computer waiting for this owner to approve it (src/join.ts); the warning is the anti-phishing part, so it shows every time */
for(const m of (JN&&JN.ok?JN.result.pending:[])){const w=el("div","row joinreq"),t=el("div");t.append(el("span","","Computer waiting to join: "+m.name+" ("+m.os+"), code "+m.code),el("small","","From "+m.ip+(m.location?" ("+m.location+")":", place unknown")+" · expires "+new Date(m.expires).toLocaleTimeString()),el("p","warn",m.warning));
const b=el("div");b.append(btn("Approve","joinyes",()=>act({op:"join_approve",code:m.code},m.name+" joined. It is one of your devices now; revoke it any time.")),document.createTextNode(" "),btn("Deny","sec joinno",()=>act({op:"join_deny",code:m.code},"Denied. That computer gets nothing.")));w.append(t,b);todo.push(w)}
for(const l of R.logins||[]){const w=el("div","row");w.append(el("span","","Waiting to sign in: "+l.label+", code "+l.code));const b=el("div");b.append(btn("Approve","",()=>act({op:"login_decide",id:l.id,yes:true},"Approved. That browser is signed in now.")),document.createTextNode(" "),btn("Deny","sec",()=>act({op:"login_decide",id:l.id,yes:false},"Turned down.")));w.append(b);todo.push(w)}
/* computers (src/devices.ts): one row per machine with Kitebook; Approve asks for kitebook confirm (presence), Revoke never does */
const MR=MC&&MC.ok?MC.result:{devices:[]};if(MR.devices.length){out.push(el("h3","","Computers"));const cl=el("div");
for(const m of MR.devices){if(m.state==="revoked")continue;const w=el("div","row"),t=el("div");t.append(el("span","",m.name+" · "+m.os+(m.id===MR.this_device?" (this computer)":"")+(m.state==="pending"?" · waiting for approval":"")),el("small","","Added "+day(m.created)+" · last seen "+day(m.last_seen)+" · "+m.sessions+" browser"+(m.sessions===1?"":"s")));
/* master password: the baseline on every computer; Touch ID / Windows Hello an optional shortcut (src/devices.ts, client/password.ts) */
const pw=el("small","pw");if(m.passkey){pw.textContent="Phone passkey: approves with the phone's own PIN, fingerprint or face. Remove it to stop that."}else if(m.locked){pw.className="pw warn";pw.textContent="Master password: not set. Locked: nothing can be approved from it. On it: kitebook password set";if(m.setup){const a=el("a","","or its one-time setup link (until "+new Date(m.setup.expires).toLocaleTimeString()+")");a.href=m.setup.url;a.target="_blank";a.rel="noopener noreferrer";pw.append(document.createTextNode(" "),a)}}
else pw.textContent="Master password: "+(m.password?"set ✓"+(m.password_via?" ("+m.password_via+(m.password_at?", "+day(m.password_at):"")+")":"")+" · Change: kitebook password change on it":m.password_reset?"reset: set a new one on it before "+new Date(m.password_reset).toLocaleTimeString()+" (kitebook password set)":"not set yet: kitebook password set on it")+" · Touch ID / Windows Hello: "+(m.shortcut?"on":"off")+" (optional"+(m.shortcut?"":"; kitebook password shortcut on")+")";
t.append(pw);
const b=el("div");if(m.state==="pending")b.append(btn("Approve","",()=>act({op:"machine_approve",id:m.id},"Approved. That computer is one of your devices now.")),document.createTextNode(" "));
if(m.shortcut)b.append(btn("Touch ID off","sec",()=>act({op:"machine_shortcut_off",id:m.id},"Shortcut off. That computer confirms with its master password now.")),document.createTextNode(" "));
if(m.password&&m.state==="active")b.append(btn("Reset password","sec",()=>act({op:"machine_password_reset",id:m.id},"Reset. On that computer, set a new master password within 15 minutes: kitebook password set")),document.createTextNode(" "));
else if(m.locked&&m.state==="active"&&m.via==="join"&&!m.password_reset)b.append(btn("Allow a password","sec",()=>act({op:"machine_password_reset",id:m.id},"Allowed. On that computer, set its master password within 15 minutes: kitebook password set")),document.createTextNode(" "));
b.append(btn("Revoke","sec",()=>act({op:"machine_revoke",id:m.id},"Revoked. Its browsers and runner are signed out.")));w.append(t,b);cl.append(w)}out.push(cl)}
out.push(el("h3","","Browsers"));const dl=el("div");
for(const d of R.devices||[]){const w=el("div","row"),t=el("div");t.append(el("span","",d.label+(d.this?" (this browser)":"")),el("small","","Last used "+day(Date.parse(d.last))));
w.append(t,btn("Sign out","sec rmdev",async()=>{const x=await post({op:"device_remove",id:d.id});if(!x.ok)throw new Error(x.error);if(d.this)return location.assign("/start");msg("That browser is signed out.");await load()}));dl.append(w)}
if(!dl.childNodes.length)dl.append(el("p","note","Only this browser."));out.push(dl);
tr.push(el("h3","","Passkeys"));const pl=el("div");
if(R.readd_passkey){const b=el("div","warn readd");b.append(el("p","","Kitebook's sign-in was updated, so your passkey needs adding once more."),btn("Add your passkey again","",addPasskey));todo.push(b)}
for(const k of R.passkeys||[]){const w=el("div","row"),t=el("div");t.append(el("span","",k.label),el("small","","Added "+day(Date.parse(k.created))));w.append(t,btn("Remove","sec rmpk",()=>act({op:"passkey_remove",id:k.id},"Passkey removed.")));pl.append(w)}
if(!pl.childNodes.length)pl.append(el("p","note","None yet. With one you sign in from anywhere, without your Mac."));
const pb=el("div","bar");pb.append(btn("Add a passkey","sec",addPasskey));tr.push(pl,pb);
tr.push(el("h3","","Browsers your Mac trusts"),el("p","note","They can change what runs on your Mac. One signed in with kitebook open is trusted by itself."));
const rs=runners();if(!rs.length)tr.push(el("p","note","Connect your Mac first (Get started, step 1)."));
if(ME&&rs.length&&!meTrusted()){const b=el("div","warn");b.append(el("p","","Your Mac doesn't know this browser yet, so changes here that your Mac applies wait. Press Trust next to this browser in a browser your Mac already trusts, or sign in here with kitebook open on your Mac."));tr.push(b)}
if(!ME&&MEERR)tr.push(el("p","warn","This browser can't sign changes ("+MEERR+")."));
for(const k of ST.owner_keys||[]){const w=el("div","row"),t=el("div"),by=trustedBy(k.fp),mine=ME&&k.key===ME.pub;w.id="key-"+k.fp;
t.append(el("span","",k.label+(mine?" (this browser)":"")),el("small","",(by.length?"Trusted by "+by.map(r=>r.name).join(", "):"Not trusted by your Mac yet")+" · key "+k.fp));const b=el("div");
if(!by.length&&rs.length&&meTrusted())b.append(btn("Trust","trust",()=>macCmd({do:"trust",key:k.key},k.label+" is trusted now.")));
if(!mine)b.append(document.createTextNode(" "),btn("Forget","sec forget",async()=>{if(by.length&&meTrusted())await macCmd({do:"untrust",key:k.key},"Your Mac forgot "+k.label+".");const x=await post({op:"owner_key",remove:k.fp,nonce:await nonce()});if(!x.ok)throw new Error(x.error);msg("Forgot "+k.label+".");await load()}));
w.append(t,b);tr.push(w)}
box.replaceChildren(...out);$("trust-box").replaceChildren(...tr);$("todo-d").replaceChildren(...todo);
const nb=(R.devices||[]).length,mk=MR.devices.filter(m=>m.state==="active").map(m=>m.name);sumv("devices",[names(mk),nb+" browser"+(nb===1?"":"s")].filter(Boolean).join(" · "));
const np=(R.passkeys||[]).length,nk=(ST.owner_keys||[]).filter(k=>trustedBy(k.fp).length).length;sumv("trust",(np?np+" passkey"+(np===1?"":"s"):"No passkey")+(rs.length?" · "+nk+" trusted":""))}
async function addPasskey(){await pkAdd(AB,"Kitebook ("+location.host+")");msg("Passkey added. You can sign in with it from anywhere.");await load()}
// ---- approvals ----
const waysWords=r=>{const w=r.approve_ways||[],out=[];if(w.includes("dialog"))out.push("a dialog on the Mac");out.push("Terminal on that computer (kitebook approve)");return out.join(" and ")};
function renderApprovals(){const box=$("approvals-box"),out=[],rs=runners();sumv("approvals","Here"+(rs.some(r=>(r.approve_ways||[]).includes("dialog"))?", Mac dialog":"")+(rs.some(r=>{const st=r.settings||{};return st.approve?/phone/.test(st.approve):(r.approve_ways||[]).includes("phone")})?", phone":""));
if(!rs.length)out.push(el("p","note","Here, in this browser. Connect your Mac to choose where else it asks you."));
for(const r of rs){const st=r.settings||{},phone=st.approve?/phone/.test(st.approve):(r.approve_ways||[]).includes("phone"),w=el("div","item"); /* what the Mac reported last, else what it advertises */w.id="appr-"+r.name;
w.append(el("p","note",r.name+(r.online?"":" (offline)")+" asks here, in "+waysWords(r)+"."));
const L=el("label","chk"),i=document.createElement("input");i.type="checkbox";i.className="phone";i.checked=phone;L.append(i,el("span","","Also send approvals to my phone (ntfy app)"));w.append(L);
if(phone&&st.phone_topic){w.append(el("p","note","In the ntfy app, add a subscription with this name. Keep it private: it's how your Mac reaches your phone."),codeBox(st.phone_topic))}
const bar=el("div","bar"),sv=btn("Save","savephone",async()=>{if(i.checked===phone)return msg("Nothing changed.");if(!meTrusted())throw new Error("Your Mac doesn't trust this browser yet (see Passkeys and browsers).");
await macCmd({do:"approvals",phone:i.checked,runner:r.name},i.checked?"Phone approvals are on for "+r.name+".":"Phone approvals are off for "+r.name+".")});sv.id="savephone-"+r.name;bar.append(sv);w.append(bar);out.push(w)}
box.replaceChildren(...out)}
// ---- coding agents ----
const agentWords=a=>[a.tasks?"Runs tasks":"Can't run tasks here",a.ask==="read_only"?"answers quick questions read-only":a.ask==="git_check"?"answers quick questions (an answer is withheld if anything changed)":"no quick questions",a.resumes?"keeps its conversation between turns":"starts fresh each turn"].join(" · ")+".";
function renderAgents(){const box=$("agents-box"),out=[],rs=runners();
if(!rs.length)out.push(el("p","note","Connect your Mac first (Get started, step 1)."));
for(const r of rs){const w=el("div","item"),ag=r.agents;w.id="agents-"+r.name;w.append(el("h3","",r.name+(r.online?"":" (offline)")));
if(!ag){w.append(el("p","note",r.name+" hasn't said which coding agents it has yet. It does within a minute of starting; update Kitebook on it if this stays."));out.push(w);continue}
const inst=ag.filter(a=>a.installed),lab=id=>(ag.find(a=>a.id===id)||{label:id}).label;
if(!inst.length)w.append(el("p","note","No coding agent found on "+r.name+". Install one (Pi, Codex, Claude Code, Cursor, Gemini CLI, opencode, GitHub Copilot CLI or Grok CLI) and it shows up here."));
for(const a of inst){const row=el("div","row"),t=el("div"),h=el("div","ah");row.id="agent-"+r.name+"-"+a.id;h.append(el("b","",a.label));
if(a.connected)h.append(el("span","tag ok","Connected to Kitebook"));if(a.issue)h.append(el("span","tag warn","Can't run tasks"));
t.append(h,el("small","",a.issue||agentWords(a)));row.append(t);
if(a.can_connect){const b=btn(a.connected?"Connect again":"Connect",a.connected?"sec":"",async()=>{if(!meTrusted())throw new Error("Your Mac doesn't trust this browser yet (see Passkeys and browsers).");await macCmd({do:"connect_agent",agent:a.id,runner:r.name},"@")});b.id="connect-"+r.name+"-"+a.id;row.append(b)}
w.append(row)}
if(inst.some(a=>a.can_connect))w.append(el("p","note","Connect gives the agent its own notes folder in Kitebook and no task sending; change that under Connected apps."));
const miss=ag.filter(a=>!a.installed&&a.can_connect).map(a=>a.label);if(miss.length)w.append(el("p","note","Not found on "+r.name+": "+miss.join(", ")+"."));
const pa=r.project_agents||{},names=Object.keys(pa).sort(),run=ag.filter(a=>a.tasks);
if(names.length&&run.length){w.append(el("h3","","Which agent works on each project"));const f=el("div","form");
for(const p of names){const L=el("label","f",p),s=document.createElement("select");s.id="pa-"+r.name+"-"+p;L.htmlFor=s.id;
const ids=run.map(a=>a.id);if(!ids.includes(pa[p]))ids.push(pa[p]);for(const id of ids){const o=document.createElement("option");o.value=id;o.textContent=lab(id)+(run.some(a=>a.id===id)?"":" (not on this Mac)");s.append(o)}s.value=pa[p];f.append(L,s)}
const bar=el("div","bar"),sv=btn("Save","savepa",async()=>{if(!meTrusted())throw new Error("Your Mac doesn't trust this browser yet (see Passkeys and browsers).");let n=0;
for(const p of names){const v=$("pa-"+r.name+"-"+p).value;if(v!==pa[p]){await macCmd({do:"default_agent",agent:v,project:p,runner:r.name},p+" now uses "+lab(v)+" on "+r.name+".");n++}}if(!n)msg("Nothing changed.")});
sv.id="savepa-"+r.name;bar.append(sv);f.append(bar);w.append(f,el("p","note","A task that names its own agent still uses that one, if your Mac allows it."))}
out.push(w)}
box.replaceChildren(...out)}
// ---- instructions for your assistants (src/brief.ts): plain text box per workspace, Undo from the file's history, apps' suggestions ----
const at=t=>new Date(t).toLocaleString([],{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});
const whoW=b=>b==="owner"?"you":b;
async function loadBrief(){const r=await post({op:"brief"});if(!r.ok)throw new Error(r.error);renderBrief(r.result.spaces)}
const briefDo=async(space,b,ok)=>{const x=await post({op:"brief_set",space,...b,nonce:await nonce()});if(!x.ok)throw new Error(x.error);msg(x.result.warning?ok+" "+x.result.warning:x.result.unchanged?"Nothing changed.":ok);await loadBrief();return x.result};
function renderBrief(spaces){const box=$("brief-box"),out=[],multi=spaces.length>1;{const s0=spaces[0],ln=s0&&!s0.default?(s0.text.split("\\n").find(x=>x.trim()&&!/^#/.test(x.trim()))||"").trim():"";sumv("brief",!s0?"":s0.default?"Kitebook's starting text":ln.length>48?ln.slice(0,47)+"…":ln||"Yours")}
for(const sp of spaces){const sfx=multi?"-"+sp.space:"",w=el("div","item");if(multi)out.push(el("h3","","Workspace "+sp.space));
const ta=document.createElement("textarea");ta.id="brief-text"+sfx;ta.rows=8;ta.maxLength=sp.max;ta.value=sp.text;ta.setAttribute("aria-label","Instructions for your assistants");ta.placeholder="For example: Send coding work to my Mac, never to Pi directly. Ask me before you deploy or email anyone.";
const cnt=el("small","note",sp.text.length+" / "+sp.max);ta.oninput=()=>{cnt.textContent=ta.value.length+" / "+sp.max};
if(sp.default)w.append(el("p","note","This is Kitebook's starting text. Change it and press Save to make it yours."));
w.append(ta,cnt,el("p","note","A section only some apps see starts with a heading like ## @hark or ## @claude-ai @chatgpt. Never put passwords or keys here: every assistant reads it."));
const bar=el("div","bar"),sv=btn("Save","",()=>briefDo(sp.space,{action:"set",text:ta.value,base:sp.sha},"Saved. Your assistants get it from their next connection or task."));sv.id="briefsave"+sfx;bar.append(sv);
const prev=sp.history[1];if(prev){const u=btn("Undo last change","sec",()=>briefDo(sp.space,{action:"restore",commit:prev.commit,base:sp.sha},"Undone: the version from "+at(prev.at)+" is back."));u.id="briefundo"+sfx;bar.append(u)}
w.append(bar);
if(sp.suggestions.length){w.append(el("h3","","Suggested by your apps ("+sp.suggestions.length+")"));
for(const s of sp.suggestions){const c=el("div","item");c.id="sug-"+s.id;c.append(el("p","now",whoW(s.by)+" suggests new instructions · "+at(s.at)));if(s.note)c.append(el("p","note","Why: "+s.note));
if(s.warning)c.append(el("p","warn",s.warning));if(s.base!==sp.sha)c.append(el("p","note","Written against an older version; accepting replaces what is there now."));
c.append(el("pre","sug",s.text));const b2=el("div","bar"),ac=btn("Accept","",()=>briefDo(sp.space,{action:"accept",id:s.id},"Accepted. "+s.by+"'s suggestion is your instructions now (Undo puts yours back).")),dm=btn("Dismiss","sec",()=>briefDo(sp.space,{action:"dismiss",id:s.id},"Dismissed."));
ac.id="sugaccept-"+s.id;dm.id="sugdismiss-"+s.id;b2.append(ac,dm);c.append(b2);w.append(c)}}
if(sp.history.length){const d=el("details","log");d.append(el("summary","","Earlier versions ("+sp.history.length+")"));
sp.history.forEach((v,i)=>{const r=el("div","row"),t=el("div");t.append(el("span","",(i?"":"Now: ")+"by "+whoW(v.by)),el("small","",at(v.at)+" · "+v.size+" characters"));r.append(t);
if(i)r.append(btn("Put this back","sec",()=>briefDo(sp.space,{action:"restore",commit:v.commit,base:sp.sha},"The version from "+at(v.at)+" is back.")));d.append(r)});w.append(d)}
if(sp.decided.length){const d=el("details","log");d.append(el("summary","","Decided suggestions"));for(const s of sp.decided){const r=el("div","row");r.append(el("span","",whoW(s.by)+": "+s.state+(s.decided_at?" · "+at(s.decided_at):"")));d.append(r)}w.append(d)}
out.push(w)}box.replaceChildren(...out)}
// ---- updates ----
const when=t=>new Date(t).toLocaleString([],{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});
const relName=(n,v)=>v&&/^(v[0-9]|dev)/.test(v)?v:n?"release "+n:v?"version "+v:"an unknown version";
const updWords=c=>({newer:"A newer official release is ready: "+relName(c.latest_release,c.latest)+".",up_to_date:"Up to date.",no_key:"A new version is available ("+relName(c.latest_release,c.latest)+"). "+(c.why||"")+" Update now installs it because you approve it here.",no_number:"A new version is available. "+(c.why||"")+" Update now installs it because you approve it here."})[c.state]||("Not installed: "+(c.why||c.state)+".");
const histWords=h=>/ \\(relay_update(, without asking)?\\)$/.test(h.by||"")&&h.result==="installed"?"Updated by "+h.by.replace(/ \\(relay_update(, without asking)?\\)$/,"")+" to "+String(h.to||"").slice(0,7)+" at "+when(h.at)+".":when(h.at)+": "+(h.result==="installed"?"updated to "+relName(h.release,h.to)+(h.from&&!h.release?" (from "+String(h.from).slice(0,7)+")":""):h.result==="rolled back"?"tried "+relName(h.release,h.to)+", went back: "+(h.why||""):"not updated: "+(h.why||""))+" (asked by "+h.by+")";
const chWords=c=>c==="dev"?"dev channel":c==="main"?"stable channel (main)":c==="release"?"signed release":c==="local"?"local commits, on neither main nor dev":"";
const buildWords=b=>b?b.version+(b.commit?" · commit "+String(b.commit).slice(0,7):"")+(chWords(b.channel)?" · "+chWords(b.channel):"")+(b.dirty?" · with local changes":""):"";
const pendWords=q=>q.kind==="trust"?"Install updates without asking me waits for you on your Mac: run kitebook confirm "+q.code+" there (master password or fingerprint / face unlock) to turn it on. Expires "+when(q.expires)+".":q.kind==="dev"&&q.approved?q.by+" asked to update this Mac to the newest "+q.ref+" commit ("+when(q.at)+"). It installs once its tasks finish.":q.kind==="dev"?q.by+" asked to update this Mac to "+q.ref+" commit "+String(q.sha).slice(0,7)+" ("+when(q.at)+"). It waits for your approval on your Mac: run kitebook confirm "+q.code+" there (master password or fingerprint / face unlock). Expires "+when(q.expires)+"; nothing changes until you approve.":q.by+" asked for this update "+when(q.at)+". It waits for you: "+(q.why||"");
function renderUpdates(){const box=$("updates-box"),out=[],top=[],todo=[],rs=runners(),asks=(ST.spaces[0]&&ST.spaces[0].update_asks)||[],on1=rs.length>1;
/* top level: one "Install updates automatically" switch per Mac and, only while one is waiting, its Update now; the rest is here under More */
const topSw=(i,r)=>{const L=el("label","trow");L.append(el("span","","Install updates automatically"+(on1?" on "+r.name:"")),i);top.push(L)},topNow=(b,r,what)=>{const t=el("div","trow");t.append(el("span","",what+" for "+r.name),b);todo.push(t)};
const sb=ST.spaces[0]&&ST.spaces[0].server;$("server-build").textContent=sb?" · server "+buildWords(sb):""; /* which code runs where (src/build.ts, client/channel.ts) */
const s0=ST.spaces[0];if(s0&&rs.length){const au=s0.app_updates||{on:true},AL=el("label","chk"),ai=document.createElement("input");ai.type="checkbox";ai.id="appupd";ai.checked=au.on!==false;AL.append(ai,el("span","","Let apps update Kitebook"));ai.onchange=async()=>{const on=ai.checked;try{const x=await post({op:"app_updates",space:s0.space,on,nonce:await nonce()});if(!x.ok)throw new Error(x.error);s0.app_updates=x.result;msg(on?"Your apps can update Kitebook again (only ever to the latest).":"Apps can't update Kitebook now. Only you can, with Update now.")}catch(e){ai.checked=!on;msg(e.message)}};out.push(AL,el("p","note","When one of your apps asks, your Mac updates right away to the latest: the newest commit of the branch it follows (dev with Experimental on), or the newest signed release. Never a version the app picks, never back, and it goes back by itself if the new version doesn't start."))} /* relay_update's kill switch (src/space/peers.ts) */
if(!rs.length){out.push(el("p","note","Connect your Mac first (Get started, step 1)."));const L=el("div","trow");L.append(el("span","","Install updates automatically"),el("span","v","no Mac yet"));top.push(L)}
for(const r of rs){const u=(r.settings&&r.settings.update)||null,c=u&&u.check,w=el("div","item");w.id="upd-"+r.name;w.append(el("h3","",r.name+(r.online?"":" (offline)")));if(u&&u.cli)w.append(el("p","warn","The kitebook command isn't on "+r.name+"'s PATH yet: "+String(u.cli).replace(/^kitebook isn't on your PATH yet\\. /,"")));
if(r.build){const p=el("p","note","Version "+buildWords(r.build)+".");p.id="build-"+r.name;w.append(p)}
if(!c){w.append(el("p","note",r.name+" hasn't said which version it runs yet. It checks within a minute of starting."));out.push(w);continue}
const g=u.git;if(g){ /* a git checkout (the one-step install): stable = main; Update now for every owner, Experimental adds the dev channel */
w.append(el("p","now","Runs version "+g.head.slice(0,7)+(((r.build&&r.build.channel)||g.channel)==="dev"?" (dev channel)":"")+". "+(g.error?g.error+".":g.behind?"A newer version is ready ("+g.behind+" change"+(g.behind===1?"":"s")+").":"Up to date.")),el("p","note","Checked "+when(g.checked_at)+"."));
const lu=(u.history||[]).find(h=>String(h.by||"").indexOf(" (relay_update")>0&&h.result==="installed");if(lu){const p=el("p","note",histWords(lu));p.id="lastapp-"+r.name;w.append(p)}
for(const q of u.pending||[])w.append(el("p","warn",pendWords(q)));
const bar=el("div","bar"),tr=()=>{if(!meTrusted())throw new Error("Your Mac doesn't trust this browser yet (see Passkeys and browsers).")};
if(g.behind){const b=btn("Update now","updnow",async()=>{tr();await macCmd({do:"update_ref",ref:"main",runner:r.name},"@")});b.id="updnow-"+r.name;topNow(b,r,"Update ready")}
if(exAny()){const m=btn("Update to dev now","sec upddev",async()=>{tr();await macCmd({do:"update_ref",ref:"dev",runner:r.name},"@")});m.id="upddev-"+r.name;m.title="dev is where tested builds land before main (the stable version Update now follows)";bar.append(m)}
const i=document.createElement("input");i.type="checkbox";i.className="auto";i.id="auto-"+r.name;i.checked=u.auto===true;topSw(i,r);
i.onchange=async()=>{const on=i.checked;try{tr();await macCmd({do:"auto_update",on,runner:r.name},on?"Automatic updates are on for "+r.name+".":"Automatic updates are off for "+r.name+".")}catch(e){i.checked=!on;msg(e.message)}};
w.append(bar,el("p","note","Updates install the stable version while "+r.name+" is idle. If the new version doesn't start, it goes back to the one before by itself."));
if((u.history||[]).length){const d=el("details","log");d.append(el("summary","","Recent updates ("+u.history.length+")"));for(const h of u.history)d.append(el("div","row",histWords(h)));w.append(d)}
out.push(w);continue}
w.append(el("p","now","Runs "+relName(c.current_release,c.current)+". "+updWords(c)),el("p","note","Checked "+when(c.checked_at)+"."));
if(c.notes&&String(c.notes).startsWith("https://")){const p=el("p","note",(c.channel==="dev"?"Dev channel. ":"")+"What changed: "),a=document.createElement("a");a.href=c.notes;a.target="_blank";a.rel="noopener";a.textContent="release notes";a.id="relnotes-"+r.name;p.append(a);w.append(p)}
for(const q of u.pending||[])w.append(el("p","warn",pendWords(q)));
const bar=el("div","bar");
if(["newer","no_key","no_number"].includes(c.state)){const b=btn("Update now","updnow",async()=>{if(!meTrusted())throw new Error("Your Mac doesn't trust this browser yet (see Passkeys and browsers).");await macCmd({do:"update",version:c.latest,runner:r.name},r.name+" is updated. It restarts once its tasks finish.")});b.id="updnow-"+r.name;topNow(b,r,"Update ready")}
if(exAny()){const m=btn("Update to dev now","sec upddev",async()=>{if(!meTrusted())throw new Error("Your Mac doesn't trust this browser yet (see Passkeys and browsers).");await macCmd({do:"update_ref",ref:"dev",runner:r.name},"@")});m.id="upddev-"+r.name;m.title="dev is where tested builds land before main (the stable branch Update now and kitebook update follow)";bar.append(m)}
const i=document.createElement("input");i.type="checkbox";i.className="auto";i.id="auto-"+r.name;i.checked=u.auto!==false;topSw(i,r);
i.onchange=async()=>{const on=i.checked;try{if(!meTrusted())throw new Error("Your Mac doesn't trust this browser yet (see Passkeys and browsers).");await macCmd({do:"auto_update",on,runner:r.name},on?"Automatic updates are on for "+r.name+".":"Automatic updates are off for "+r.name+".")}catch(e){i.checked=!on;msg(e.message)}};
w.append(bar);
if((u.history||[]).length){const d=el("details","log");d.append(el("summary","","Recent updates ("+u.history.length+")"));for(const h of u.history)d.append(el("div","row",histWords(h)));w.append(d)}
out.push(w)}
if(asks.length){const d=el("details","log");d.open=true;d.append(el("summary","","Agents that asked for an update ("+asks.length+")"));
for(const a of asks)d.append(el("div","row",when(a.at)+": "+a.by+" asked. "+a.runners.map(x=>x.why).join(" ")));out.push(d)}
box.replaceChildren(...out);$("updrows").replaceChildren(...top);$("todo-u").replaceChildren(...todo);sumv("updates",!rs.length?"No Mac yet":todo.length?"Update ready":"Up to date")}
// ---- releases ----
function renderReleases(){const box=$("releases-box"),out=[];sumv("releases",S.release?"Signed updates":"Not signed");
if(S.release){out.push(el("p","","Installs from this Kitebook accept only updates signed with this key:"),codeBox(S.release,"Copy key"))}else out.push(el("p","note","This Kitebook doesn't sign its updates yet, so installs trust it because it sent them."));
for(const r of runners()){const st=r.settings||{},w=el("div","item");w.id="rel-"+r.name;w.append(el("h3","","Release key on "+r.name));
if(st.release_key){w.append(el("p","note","Made on "+r.name+". The private half stays in its keychain. Sign a release there with kitebook release sign."),codeBox(st.release_key,"Copy key"));
const rot=btn("Make a new one","danger rot",async b=>{if(!b.classList.contains("sure")){b.classList.add("sure");b.textContent="Yes, replace it (installs pinned to the old key stop updating)";setTimeout(()=>{b.classList.remove("sure");b.textContent="Make a new one"},6000);return}
await macCmd({do:"release_key",rotate:true,runner:r.name},"New release key made on "+r.name+".")});const bar=el("div","bar");bar.append(rot);w.append(bar)}
else{w.append(el("p","note","None yet. One click makes it on "+r.name+" and keeps the private half in its keychain."));const bar=el("div","bar"),c=btn("Create release key","mkrel",async()=>{if(!meTrusted())throw new Error("Your Mac doesn't trust this browser yet (see Passkeys and browsers).");await macCmd({do:"release_key",runner:r.name},"Release key made on "+r.name+".")});c.id="mkrel-"+r.name;bar.append(c);w.append(bar)}
out.push(w)}
box.replaceChildren(...out)}
// ---- connection: the address assistants use; with no server or domain, the built-in tunnel on your Mac (client/tunnel.ts) ----
let CN=null;
let IG=null;
async function loadConn(){const[r,g]=await Promise.all([post({op:"connection"}),post({op:"ingress"})]);CN=r.ok?r.result:null;IG=g.ok?g.result:null;renderConn()}
function lockBox(){const w=el("div","item");w.id="lockdown";if(!IG)return w;const on=IG.enforced,hd=el("div","ah");hd.append(el("b","","Public address lockdown"),el("span","tag"+(on?" ok":" warn"),on?"on":IG.setting==="off"?"off":"not yet"));
w.append(hd,el("p","now",IG.why[0].toUpperCase()+IG.why.slice(1)+"."),el("p","note",(on?"From the public address, apps reach only: ":"With it on, apps reach only: ")+IG.edge_routes.slice(0,5).join("; ")+". The rest is 'not found' unless you're signed in."),
el("p","note","You opened this page "+(IG.via==="local"?"on this computer.":"through the public address.")+(IG.local_listener?"":" No local listener here.")));
const bar=el("div","bar");if(IG.setting!=="on"){const b=btn("Turn lockdown on","",async()=>{await lockSet("on","Lockdown is on.")});b.id="lockon";bar.append(b)}
if(IG.setting!=="off"){const b=btn("Turn lockdown off","sec",async()=>{await lockSet("off","Lockdown is off.")});b.id="lockoff";if(IG.via!=="local")b.title="Only on this computer's own Kitebook page";bar.append(b)}
w.append(bar);return w}
async function lockSet(v,ok){const x=await post({op:"ingress_set",lockdown:v,nonce:await nonce()});if(!x.ok)throw new Error(x.error);IG=x.result;msg(ok);renderConn()}
const ago=t=>{const s=Math.max(0,Math.round((Date.now()-t)/1000));return s<90?s+" seconds ago":Math.round(s/60)+" minutes ago"};
function renderConn(){const box=$("connection-box"),out=[],fin=()=>{out.push(lockBox());box.replaceChildren(...out)};if(!CN){$("addr-v").textContent="Couldn't read it";box.replaceChildren(el("p","note","Couldn't read the connection. Reload the page."),lockBox());return}
const t=CN.tunnel,stale=!!t&&Date.now()-t.heard>30000,pub=t?(t.state==="up"&&t.url&&!stale?t.url:null):CN.origin;
const loop=!!pub&&/^http:\\/\\/(127\\.\\d+\\.\\d+\\.\\d+|localhost|\\[::1\\])(:|\\/|$)/.test(pub); /* a local-only Kitebook: never call 127.0.0.1 "public" */
{const v=$("addr-v"),row=$("addr");v.textContent=pub?(loop?"Local only":pub.replace(/^https?:\\/\\//,"")):"Public access off";sumv("connection",v.textContent);[...row.querySelectorAll("button")].forEach(b=>b.remove());if(pub)row.append(btn("Copy","sec",async()=>msg(await copyText(pub)?"Copied":"Select the address and copy it by hand")));$("addr-warn").hidden=!loop} /* the top-level Address row */
if(loop){out.push(el("h3","","Local only"),codeBox(pub,"Copy address"),el("p","note","This address only works on this computer: Claude.ai, ChatGPT and Hark can't reach it. Turn on public access (kitebook tunnel on) or deploy it; coding agents here connect as is."))}
else if(pub){out.push(el("h3","","Your public address"),codeBox(pub,"Copy address"),el("p","note","Connect Claude.ai or ChatGPT with this link (add it as a custom connector):"),codeBox(pub+"/mcp","Copy link"))}
if(!t){if(!loop)out.push(el("p","note",CN.operator?"This Kitebook has its own address, so it doesn't use Kitebook's built-in tunnel.":"This is the address of the server you use."));fin();return}
if(t.mode==="off"&&!stale){ /* public access off (the one-step install starts this way): one switch turns the built-in tunnel on */
const h=el("div","item");h.id="tunnel-health";h.append(el("h3","","Public access: off"),el("p","now","Only this Mac can reach Kitebook right now. Its runner and coding agents work as they are."),el("p","note","Claude.ai, ChatGPT and Hark run in the cloud, so they need a public address. Turn it on and Kitebook gives your Mac one, free, with no account: a Cloudflare quick tunnel. Every request through it still needs your sign-in."));out.push(h);
if(CN.pending)out.push(el("p","note","Sent to your Mac. It turns public access on within a few seconds."));
if(CN.operator){const bar=el("div","bar"),on=btn("Turn on public access","",async()=>{await tunnelAct({action:"on"},"Turning on public access. Your address shows here in a few seconds.")});on.id="tunnelon";bar.append(on);out.push(bar)}
fin();return}
const kind=t.mode==="named"?"Your Cloudflare tunnel: the address stays the same":"Free quick tunnel: no account needed, but the address changes when it restarts";
let health;
if(stale)health=["warn","The tunnel helper on your Mac isn't answering (last heard "+ago(t.heard)+"). On the Mac, run: kitebook restart tunnel"];
else if(t.state==="up")health=["ok","Working. Your assistants reach your Mac through it."];
else if(t.state==="starting")health=["","Starting. This takes a few seconds."];
else if(t.state==="stopped")health=["warn","Stopped. On the Mac, run: kitebook start tunnel"];
else health=["warn","Not working right now"+(t.error?" ("+t.error+")":"")+". It tries again by itself, or press Restart tunnel."];
const h=el("div","item");h.id="tunnel-health";const hd=el("div","ah");hd.append(el("b","","Tunnel"),el("span","tag"+(health[0]?" "+health[0]:""),stale?"not answering":t.state==="up"?"working":t.state));
h.append(hd,el("p","now",health[1]),el("p","note",kind+(t.since?". Since "+when(Date.parse(t.since))+".":".")));out.push(h);
if(t.previous&&t.changed_at&&Date.now()-Date.parse(t.changed_at)<14*DAY){const w=el("p","warn","Your address changed "+when(Date.parse(t.changed_at))+" because the tunnel restarted. Assistants you added with the old address ("+t.previous+") stop working until you add them again with the link above. Your Mac's runner and coding agents use the local address, so they keep working.");w.id="tunnelchanged";out.push(w)}
if(CN.pending)out.push(el("p","note","Sent to your Mac: "+({restart:"restart the tunnel",token:"use your Cloudflare tunnel",quick:"go back to the quick tunnel",on:"turn public access on",off:"turn public access off"})[CN.pending.what]+". It does it within a few seconds."));
if(CN.operator){const bar=el("div","bar"),rb=btn("Restart tunnel","sec",async()=>{const here=location.origin===t.url;await tunnelAct({action:"restart"},here&&t.mode==="quick"?"Restarting. This page is open through the tunnel, so it stops answering: open "+t.local+"/settings on your Mac to copy the new address.":t.mode==="quick"?"Restarting. Your address changes: copy the new one here in a few seconds.":"Restarting the tunnel.")});rb.id="tunnelrestart";const off=btn("Turn off public access","sec",async()=>{await tunnelAct({action:"off"},location.origin===t.url?"Turning off public access. This page is open through the tunnel, so it stops answering: open "+t.local+"/settings on your Mac.":"Turning off public access. Only this Mac reaches Kitebook then.")});off.id="tunneloff";bar.append(rb,off);out.push(bar);
const d=el("details","log");d.id="tunnelown";d.append(el("summary","",t.mode==="named"?"Your Cloudflare tunnel":"Keep the same address (optional)"));
if(t.mode==="named"){d.append(el("p","note","Your Mac uses your Cloudflare tunnel at "+(t.hostname||"your hostname")+"."));const q=btn("Go back to the free quick tunnel","sec",async()=>{await tunnelAct({action:"quick"},"Switching back to the quick tunnel.")});q.id="tunnelquick";const b2=el("div","bar");b2.append(q);d.append(b2)}
else{d.append(el("p","note","Have a Cloudflare account and a domain? Create a tunnel there (Zero Trust, then Networks, then Tunnels), give it a hostname that points to http://localhost:"+(t.port?t.port+1:7821)+" (Kitebook's public listener; the dashboard stays on this computer), and paste its token here. Your address then never changes."));
const tl=el("label","f","Tunnel token"),ti=document.createElement("input");ti.type="password";ti.id="tunneltoken";ti.autocomplete="off";tl.htmlFor=ti.id;
const hl=el("label","f","Its hostname"),hi=document.createElement("input");hi.type="text";hi.id="tunnelhost";hi.placeholder="kitebook.example.com";hi.setAttribute("autocapitalize","off");hl.htmlFor=hi.id;
const sv=btn("Use my tunnel","",async()=>{await tunnelAct({action:"token",token:ti.value.trim(),hostname:hi.value.trim()},"Sent to your Mac. It switches to your tunnel in a few seconds.");ti.value=""});sv.id="tunnelsave";const b3=el("div","bar");b3.append(sv);d.append(tl,ti,hl,hi,b3)}
out.push(d)}
fin()}
async function tunnelAct(b,ok){const x=await post({op:"tunnel_act",...b,nonce:await nonce()});if(!x.ok)throw new Error(x.error);msg(ok);await loadConn();connWatch()}
let cw=0;function connWatch(){clearTimeout(cw);let n=0;const tick=async()=>{n++;await loadConn();if(n<20&&CN&&(CN.pending||(CN.tunnel&&CN.tunnel.state!=="up")))cw=setTimeout(tick,2000)};cw=setTimeout(tick,2000)}
// ---- recovery ----
$("rcnew").onclick=async()=>{try{const r=await post({op:"recovery_new",nonce:await nonce()});if(!r.ok)throw new Error(r.error);$("rcode").textContent=r.result.recovery_code;$("rcout").hidden=false;msg("New recovery code made. The old one no longer works.")}catch(e){msg(e.message)}};
$("rccopy").onclick=async()=>{msg(await copyText($("rcode").textContent)?"Copied":"Select the code and copy it by hand")};$("rcprint").onclick=()=>window.print();
load();setInterval(()=>{if(!document.hidden&&!document.querySelector("details.chg[open]")&&!pending.size)load()},20000);
</script></body></html>`;
}
