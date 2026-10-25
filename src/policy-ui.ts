// Browser side of the owner's standing permissions, shared by /start (Permissions), the consent page and the review page's "Always
// allow". The owner key is a P-256 key made in this browser by WebCrypto, NOT extractable, kept in IndexedDB; only its public half
// goes to the server (registered so the server can check signatures) and to the Mac (which trusts it: client/settings-sync.ts). Each change reads the current policy,
// signs the next version here over the same canonical JSON the runner checks (canon below is client/payload.ts's own source), and
// sends it with a one-time nonce. No user text is ever put into the page as HTML. A browser signed in with a `kitebook open` link holds that
// link's trust secret (sessionStorage, from the #fragment) and proves it with an HMAC when it registers its key, so the Mac trusts it with
// no fingerprint to compare (client/settings-sync.ts); any other browser is trusted by a click in a browser the Mac already trusts (cmd trust).
import { PRESENCE_JS } from "./presence-ui.ts";
import { canon, keepSessions } from "../client/payload.ts";

// sw: the two switches as the next version carries them (autorun, experimental); a legacy dev field reads as both and is never written
// again (client/payload.ts migratePolicy). autorun(on, until) / experimental({ci, gh_status} | null): one signed change each.
export const OWNER_JS = `const OWN=(()=>{const te=new TextEncoder(),b64u=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"");
const canon=(${canon.toString()});
const keepSessions=(${keepSessions.toString()});
${PRESENCE_JS}
const sp=async b=>{const r=await withPresence(()=>fetch("/start",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b)}));return await r.json()};
const idb=()=>new Promise((ok,no)=>{const r=indexedDB.open("kitebook-owner",1);r.onupgradeneeded=()=>r.result.createObjectStore("keys");r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error)});
const get=async k=>{const d=await idb();return await new Promise((ok,no)=>{const q=d.transaction("keys").objectStore("keys").get(k);q.onsuccess=()=>ok(q.result);q.onerror=()=>no(q.error)})};
const put=async(k,v)=>{const d=await idb();return await new Promise((ok,no)=>{const t=d.transaction("keys","readwrite");t.objectStore("keys").put(v,k);t.oncomplete=()=>ok();t.onerror=()=>no(t.error)})};
const fp=async k=>[...new Uint8Array(await crypto.subtle.digest("SHA-256",te.encode(k)))].map(b=>b.toString(16).padStart(2,"0")).join("").slice(0,16).match(/..../g).join("-");
async function key(acct){let k=await get("owner:"+acct);if(!k){const kp=await crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},false,["sign","verify"]);
k={priv:kp.privateKey,pub:"p256:"+b64u(await crypto.subtle.exportKey("spki",kp.publicKey))};await put("owner:"+acct,k)}return {...k,fp:await fp(k.pub)}}
const nonce=async()=>{const n=await sp({op:"nonce"});if(!n.ok)throw new Error(n.error);return n.result.nonce};
const label=()=>{const u=navigator.userAgent;return (/iPhone|iPad/.test(u)?"iPhone":/Android/.test(u)?"Android":/Mac/.test(u)?"Mac":/Windows/.test(u)?"Windows":/Linux/.test(u)?"Linux":"browser")+", "+(/Firefox/.test(u)?"Firefox":/Edg/.test(u)?"Edge":/Chrome|Chromium/.test(u)?"Chrome":/Safari/.test(u)?"Safari":"browser")};
const hmac=async(sec,msg)=>b64u(await crypto.subtle.sign("HMAC",await crypto.subtle.importKey("raw",te.encode(sec),{name:"HMAC",hash:"SHA-256"},false,["sign"]),te.encode(msg)));
async function ready(acct,known){const k=await key(acct);let t=null;try{t=sessionStorage.getItem("relay-trust")}catch(e){}
if(!(known||[]).some(x=>x.key===k.pub)){const r=await sp({op:"owner_key",key:k.pub,label:label(),...(t?{proof:await hmac(t,"relay-trust:v1|"+k.pub)}:{}),nonce:await nonce()});if(!r.ok)throw new Error(r.error)}
try{sessionStorage.removeItem("relay-trust")}catch(e){}return k}
async function read(space){const st=await sp({op:"policy",space});if(!st.ok)throw new Error(st.error);return st.result}
async function set(acct,space,app,entry,access,undo){const st=await read(space),s=st.spaces[0],k=await ready(acct,st.owner_keys);
const cur=s.envelope?s.envelope.policy:null,apps={...(cur?cur.apps:{})},old=cur&&cur.apps[app];
/* the Agent sessions switch (live-sessions) is its own setting: a task/folder change keeps it (Undo restores exactly what was there) */
if(!undo)entry=keepSessions(old,entry);
if(entry)apps[app]=entry;else delete apps[app];
const p={v:1,type:"relay-policy",space,seq:(cur?cur.seq:0)+1,at:Date.now(),apps,...sw(cur)};const sig=await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},k.priv,te.encode("relay-policy:v1|"+canon(p)));
const r=await sp({op:"policy_set",space,app,envelope:{policy:p,key:k.pub,sig:b64u(sig)},access:access||null,undo_of:undo||null,nonce:await nonce()});if(!r.ok)throw new Error(r.error);return r.result}
const sw=cur=>{if(!cur)return {};const o={},d=cur.dev,ar=cur.autorun||d,ex=cur.experimental||(d&&d.on&&(!d.until||d.until>Date.now())?{on:true}:null);if(ar)o.autorun=ar;if(ex)o.experimental=ex;return o};
const signed=async(acct,space,st,cur,change)=>{const k=await ready(acct,st.owner_keys),p={v:1,type:"relay-policy",space,seq:(cur?cur.seq:0)+1,at:Date.now(),apps:{...(cur?cur.apps:{})},...sw(cur)};change(p);
const sig=await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},k.priv,te.encode("relay-policy:v1|"+canon(p)));return {policy:p,key:k.pub,sig:b64u(sig)}};
async function autorun(acct,space,on,until,undo){const st=await read(space),s=st.spaces[0],cur=s.envelope?s.envelope.policy:null;
let d=null;if(on){const n=await sp({op:"autorun_key",space,nonce:await nonce()});if(!n.ok)throw new Error(n.error);d={on:true,until:until||null,keys:[n.result.pub]}}
const envelope=await signed(acct,space,st,cur,p=>{if(d)p.autorun=d;else delete p.autorun});
const r=await sp({op:"autorun_set",space,envelope,undo_of:undo||null,nonce:await nonce()});if(!r.ok)throw new Error(r.error);return r.result}
async function experimental(acct,space,x,undo){const st=await read(space),s=st.spaces[0],cur=s.envelope?s.envelope.policy:null;
const envelope=await signed(acct,space,st,cur,p=>{if(x)p.experimental={on:true,...(x.ci===false?{ci:false}:{}),...(x.gh_status?{gh_status:true}:{})};else delete p.experimental});
const r=await sp({op:"experimental_set",space,envelope,undo_of:undo||null,nonce:await nonce()});if(!r.ok)throw new Error(r.error);return r.result}
/* Agent sessions (live-sessions): off | read | write for one app, nothing else changes; needs presence like every widening change */
async function sessions(acct,space,app,level){const s=(await read(space)).spaces[0],e=s.envelope&&s.envelope.policy.apps[app];
return await set(acct,space,app,{...(e||{tasks:"ask",projects:[]}),sessions:level},null)}
async function appKey(space,app){const r=await sp({op:"app_key",space,app,nonce:await nonce()});if(!r.ok)throw new Error(r.error);return r.result.pub}
async function allow(acct,space,app,projects,until){const s=(await read(space)).spaces[0],e=s.envelope&&s.envelope.policy.apps[app],live=e&&e.tasks==="auto"&&(!e.until||e.until>Date.now());
const keys=live&&e.keys&&e.keys.length?e.keys:[await appKey(space,app)];
return await set(acct,space,app,{tasks:"auto",projects:[...new Set([...(live?e.projects:[]),...projects])].sort(),push:!!(live&&e.push),until:until!==undefined?until:live?e.until||null:null,keys},null)}
/* a Settings change the Mac does (trust or forget a browser, approvals on the phone, a release key): signed here like the policy */
async function cmd(acct,space,c,known){const k=await ready(acct,known);const m={v:1,type:"relay-owner-cmd",space,id:b64u(crypto.getRandomValues(new Uint8Array(12))),at:Date.now(),runner:null,...c};
const sig=await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},k.priv,te.encode("relay-owner-cmd:v1|"+canon(m)));
const r=await sp({op:"owner_cmd",space,cmd:{cmd:m,key:k.pub,sig:b64u(sig)},nonce:await nonce()});if(!r.ok)throw new Error(r.error);return r.result}
return {key,ready,read,set,allow,appKey,cmd,autorun,experimental,sessions}})();`;
