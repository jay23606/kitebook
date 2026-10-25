// Browser side of the presence gate (src/devices.ts): a request answered 428 {presence} asks for a short code (/start presence_ask), shows
// "run kitebook confirm <code>" until one of the owner's devices confirms (its master password, or the optional Touch ID / Windows Hello shortcut), then sends the
// same request again (its one-time nonce is checked only after the gate, so it still works). Pages include it ahead of their own JS.
export const PRESENCE_JS = `
/* a phone's passkey as an approval device (src/passkey.ts): kbPk.get(challenge) answers a server challenge with this phone's passkey (its PIN /
   fingerprint / face); kbPk.on() = this browser added one (localStorage, a hint only: the server decides) */
if(!window.kbPk){const B=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,""),D=s=>Uint8Array.from(atob(s.replace(/-/g,"+").replace(/_/g,"/")+"===".slice((s.length+3)%4)),c=>c.charCodeAt(0));
window.kbPk={B,D,on:()=>!!window.PublicKeyCredential&&localStorage.getItem("kb-approver-passkey")==="1",
get:async c=>{const a=await navigator.credentials.get({publicKey:{challenge:D(c.challenge),rpId:c.rp_id,allowCredentials:(c.allow||[]).map(id=>({type:"public-key",id:D(id)})),userVerification:"required",timeout:60000}});
return{id:B(a.rawId),client_data:B(a.response.clientDataJSON),auth_data:B(a.response.authenticatorData),sig:B(a.response.signature)}}}}
if(!window.withPresence)window.withPresence=async f=>{let r=await f();if(r.status!==428)return r;let b={};try{b=await r.clone().json()}catch(e){}if(!b.presence)return r;
const sp=async x=>(await fetch("/start",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(x)})).json();
const a=await sp({op:"presence_ask",action:b.presence.action});if(!a.ok)return r;
const o=document.createElement("div");o.id="presence-ask";o.setAttribute("role","dialog");o.style.cssText="position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:99";
const c=document.createElement("div");c.style.cssText="background:Canvas;color:CanvasText;max-width:26rem;padding:1.2rem 1.4rem;border-radius:12px;font:15px system-ui";
const p1=document.createElement("p");p1.textContent="Confirm it's you on one of your computers. In Terminal, run:";const k=document.createElement("pre");k.style.cssText="font-size:1.1rem;user-select:all";k.textContent="kitebook confirm "+a.result.code;
const p2=document.createElement("p");p2.textContent="It asks for your Kitebook master password (or Touch ID / Windows Hello, if you turned that shortcut on), then this page goes on by itself.";const x=document.createElement("button");x.textContent="Cancel";
c.append(p1,k,p2);
let done=false;if(kbPk.on()){const pb=document.createElement("button"),pm=document.createElement("p");pb.type="button";pb.textContent="Approve with passkey";pb.id="presence-pk";pm.setAttribute("role","status");
pb.onclick=async()=>{pb.disabled=true;try{const ch=await sp({op:"presence_passkey_challenge",id:a.result.id});if(!ch.ok||!ch.result.challenge)throw new Error(ch.error||"no passkey is set up for approvals");
const q=await sp({op:"presence_passkey",id:a.result.id,passkey:await kbPk.get(ch.result)});if(!q.ok)throw new Error(q.error);done=true;pm.textContent="Confirmed."}catch(e){pm.textContent=e.message||"Not confirmed"}finally{pb.disabled=false}};
c.prepend(pb,pm)}
/* not at a computer (a phone): type the master password here; it goes over HTTPS to your Mac, which checks it and forgets it (src/remote-pw.ts) */
if(a.result.remote){const f=document.createElement("form"),lb=document.createElement("label"),pw=document.createElement("input"),go=document.createElement("button"),m=document.createElement("p");
lb.textContent="Kitebook master password (checked by your Mac):";lb.htmlFor="presence-pw";pw.type="password";pw.id="presence-pw";pw.autocomplete="current-password";pw.style.cssText="display:block;width:100%;margin:.4rem 0;font:inherit;padding:.4rem";go.type="submit";go.textContent="Confirm";m.setAttribute("role","status");
f.onsubmit=async e=>{e.preventDefault();if(!pw.value)return;const password=pw.value;pw.value="";go.disabled=true;m.textContent="Checking with your Mac…";try{const q=await sp({op:"presence_password",id:a.result.id,password});if(q.ok){done=true;m.textContent="Confirmed."}else m.textContent=q.error||"Not confirmed"}catch(e){m.textContent="Couldn't confirm. Check your connection and try again."}finally{go.disabled=false}};
f.append(lb,pw,go,m);c.prepend(f)}
c.append(x);o.append(c);document.body.append(o);let stop=false;x.onclick=()=>{stop=true};
try{for(let i=0;i<200&&!stop;i++){await new Promise(z=>setTimeout(z,done?50:1500));const s=await sp({op:"presence_state",id:a.result.id});if(s.ok&&s.result.state==="confirmed")return await f();if(!s.ok||s.result.state!=="open")break}}finally{o.remove()}
return r};`;
