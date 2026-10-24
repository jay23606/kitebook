// Kitebook's one look ("Quiet page", ui-design 2026-10-22; owner: "fragmented and difficult to see, apply minimalist perspective").
// One column, whitespace instead of boxes, one accent plus neutrals, big legible type. Every page (/start, Settings, the approval page,
// the consent and device pages, /open) takes THEME_CSS (the colour tokens, light + dark from the system) and BASE_CSS (type, buttons,
// fields, disclosures, code, toast). System fonts only: no external font or CDN, nothing the CSP has to allow (style-src 'unsafe-inline').
// Contrast (WCAG AA, checked): light text #111418 18.5:1, muted #4a5160 8:1 (7.3:1 on --soft), accent #0f6e5c 6.2:1 both ways with white;
// field borders #858b97 / #666d78 3.4:1 / 3.6:1 (non-text contrast); dark text #f1f3f5 17:1, muted #a9afba 8.6:1, accent #3fd1b2 9.9:1 as text, #06231d on it 8.7:1, danger #ff8a7a 8.3:1.
// The older token names (--acc, --mut, --card, --ok, --needbg, …) stay: the page scripts and a few rules still use them.
export const THEME_CSS = `:root{color-scheme:light dark;--bg:#fff;--fg:#111418;--mut:#4a5160;--line:#e7e9ee;--card:#fff;--soft:#f4f5f7;--acc:#0f6e5c;--acc2:#0b5a4b;--onacc:#fff;--link:#0f6e5c;--danger:#b42318;--warnbg:transparent;--warnline:#0f6e5c;--ok:transparent;--needbg:#e3f1ed;--badbg:transparent;--devbg:transparent;--focus:#0f6e5c;--field:#858b97}
@media (prefers-color-scheme:dark){:root{--bg:#0f1113;--fg:#f1f3f5;--mut:#a9afba;--line:#262a30;--card:#0f1113;--soft:#1a1d21;--acc:#3fd1b2;--acc2:#6fe0c7;--onacc:#06231d;--link:#3fd1b2;--danger:#ff8a7a;--warnline:#3fd1b2;--needbg:#12302a;--focus:#3fd1b2;--field:#666d78}}`;
// shared base: type scale 14/16/17/20/28, weights 400/600, spacing 4/8/16/24/40/64, radius 12, 48 px targets, 3 px focus ring
export const BASE_CSS = `*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.55 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--link);text-underline-offset:3px}h1,h2,h3{line-height:1.25;letter-spacing:-.01em;font-weight:600}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px;border-radius:8px}
button,a.btn{font:inherit;font-size:16px;font-weight:600;line-height:1.2;min-height:48px;padding:12px 20px;border-radius:12px;border:0;background:var(--soft);color:var(--fg);cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;transition:background-color .12s,color .12s,opacity .12s}
button:hover,a.btn:hover{background:var(--line)}button:disabled{opacity:.45;cursor:default}
button.pri,a.btn.pri{background:var(--acc);color:var(--onacc)}button.pri:hover,a.btn.pri:hover{background:var(--acc2)}
button.link{background:none;border:0;color:var(--link);padding:0;min-height:0;font-weight:400;font-size:inherit;text-decoration:underline;text-underline-offset:3px}button.link:hover{background:none}
input,select,textarea{font:inherit;font-size:17px;color:var(--fg);background:var(--bg);border:1px solid var(--field);border-radius:12px;padding:12px 14px;width:100%;min-height:48px}
input:focus,select:focus,textarea:focus{border-color:var(--acc);outline:none;box-shadow:0 0 0 3px color-mix(in srgb,var(--acc) 25%,transparent)}
input[type=checkbox],input[type=radio]{width:20px;height:20px;min-height:0;padding:0;accent-color:var(--acc)}
code{background:var(--soft);padding:2px 6px;border-radius:6px;font:15px ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
pre{margin:0;white-space:pre-wrap;word-break:normal;overflow-wrap:anywhere;background:var(--soft);padding:14px 16px;border-radius:12px;font:14px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--fg)}
details>summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:10px;min-height:44px}details>summary::-webkit-details-marker{display:none}
details>summary::before{content:"";flex:none;width:7px;height:7px;border:solid currentColor;border-width:0 2px 2px 0;transform:rotate(-45deg);transition:transform .12s;margin:0 3px}
details[open]>summary::before{transform:rotate(45deg)}
.note,.lead{color:var(--mut)}.st{font-weight:600}
.warn{background:none;border:0;border-left:3px solid var(--warnline);padding:2px 0 2px 16px;margin:16px 0;border-radius:0}.warn p{margin:0 0 6px}
[hidden]{display:none!important}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}`;

// Folds (owner, 2026-10-22 22:41: "more short and meaningful UI, maybe shorten by hover to collapse click to close?"): every
// <details class="fold"> is one line (its label + a meaningful summary in .v) until opened. A mouse on a hover-capable device previews a
// fold while it rests on it (it closes again when the mouse leaves, unless something inside has focus); a click pins it open; a click on
// its header closes it. Touch: a tap toggles (plain <details>). Keyboard: Enter/Space on the header toggles (plain <details>), and
// aria-expanded mirrors the state. prefers-reduced-motion drops the animation (BASE_CSS). Plain clicks still open folds the same way,
// so headless tests that click a summary see exactly the old behaviour.
export const FOLD_CSS = `details.fold[open]>:not(summary){animation:foldin .14s ease-out}@keyframes foldin{from{opacity:0;transform:translateY(-4px)}}
details.fold.peek>summary{color:var(--mut)}details.fold>summary .v{color:var(--mut)}`;
export const FOLD_JS = `(()=>{const hov=matchMedia("(hover:hover) and (pointer:fine)"),own=d=>d.querySelector(":scope>summary");
const sync=d=>{const s=own(d);if(s)s.setAttribute("aria-expanded",d.open?"true":"false");d.classList.toggle("peek",d.open&&!!d.dataset.peek)};
const wire=d=>{if(d.dataset.fw||!own(d))return;d.dataset.fw="1";let t=0;sync(d);
d.addEventListener("toggle",()=>{if(!d.open)delete d.dataset.peek;sync(d)});
d.addEventListener("pointerenter",e=>{if(e.pointerType!=="mouse"||!hov.matches||d.open)return;clearTimeout(t);t=setTimeout(()=>{if(!d.open){d.dataset.peek="1";d.open=true;sync(d)}},180)});
d.addEventListener("pointerleave",e=>{clearTimeout(t);if(e.pointerType!=="mouse"||!d.dataset.peek)return;t=setTimeout(()=>{if(d.dataset.peek&&!d.matches(":focus-within"))d.open=false},250)});
/* a click inside a previewed fold pins it; a click on its own header while previewing pins instead of closing */
d.addEventListener("click",e=>{clearTimeout(t);if(!d.dataset.peek)return;if(e.target.closest&&e.target.closest("summary")===own(d))e.preventDefault();delete d.dataset.peek;sync(d)})};
const all=()=>document.querySelectorAll("details.fold").forEach(wire);all();new MutationObserver(all).observe(document.body,{childList:true,subtree:true})})();`;
