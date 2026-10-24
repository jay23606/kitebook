import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { Plugin } from "vite";
import { PROXY_MARKS, LOOPBACK } from "./src/ingress.ts";
import { build as gitBuild } from "./client/channel.ts";

// Which code this server runs (frictions 2026-10-21: nobody could tell remotely): version, commit and channel (main | dev | local) of the
// checkout it is built from, baked into the bundle. Shown only to signed-in callers (describe.server, Settings -> Updates), never on /health.
// A build without .git (a Docker context) can say it with KITEBOOK_BUILD_VERSION / _COMMIT / _CHANNEL.
const BUILD = (() => { const g = gitBuild(process.cwd()), e = process.env;
	return { version: e.KITEBOOK_BUILD_VERSION || g?.version || "unknown", commit: e.KITEBOOK_BUILD_COMMIT || g?.commit || null, channel: e.KITEBOOK_BUILD_CHANNEL || g?.channel || "unknown", built_at: new Date().toISOString() }; })();

// Local state for `cf dev` (Durable Objects, and the R2 bucket that holds big blobs) lives in one stable folder: .relay-data/
// (override with KITEBOOK_DATA). Older checkouts kept it in the plugin default .cloudflare/state, which `cf build` output sits next to;
// if that has data and .relay-data doesn't exist yet, keep using it so a `git pull` never makes a running Kitebook look empty.
const DATA = process.env.KITEBOOK_DATA || (!existsSync(".relay-data") && existsSync(".cloudflare/state/v3/do") ? ".cloudflare/state" : ".relay-data");

// `cf dev` is for development on this machine only. Production (scripts/mac-host.sh, any self-host) runs the built bundle on plain workerd
// (selfhost/config.capnp), which serves nothing but the Worker. Vite, left alone, also serves the project folder itself: /package.json,
// /src/*.ts, ?raw of any file, /@fs/<any path>, and with the data folder inside the root, the account database. So this dev server:
//   - answers only loopback Host names (Vite's default) plus hosts named explicitly in KITEBOOK_ALLOWED_HOSTS (no tunnel wildcards),
//   - refuses every request Vite itself would answer (files under the root, /@fs, /@vite, /node_modules, dot paths, ?raw/?import/?url...),
//     so only the Worker answers, as on workerd and Cloudflare,
//   - and denies the data folder and .dev.vars through /@fs even if something above changes.
const VITE_QUERY = /(?:^|&)(?:(?:raw|url|import|inline|worker|sharedworker|html-proxy|direct)(?:&|$)|t=\d+)/; // bare markers (Vite's), never a Worker's ?url=...
export const workerOnly = (root: string) => (raw: string): boolean => { // true = refuse (Vite would serve it, not the Worker)
	const [p, q = ""] = raw.split("?", 2); let path: string; try { path = decodeURIComponent(p); } catch { return true; }
	if (path.includes("\\") || path.includes("\0") || /(^|\/)\.(?!well-known(\/|$))/.test(path) || /^\/(@|node_modules\/|__)/.test(path) || VITE_QUERY.test(q)) return true;
	if (path === "/" || path === "") return false;
	const f = resolve(root, "." + path); return (f === root || f.startsWith(root + sep)) ? existsSync(f) : true;
};
const workerOnlyPlugin = (): Plugin => ({ name: "relay-worker-only", enforce: "pre", configureServer(server) {
	const refuse = workerOnly(resolve(server.config.root));
	// the dev server's one listener stamps every request it passes on, replacing any value the client sent (src/ingress.ts; only a dev build
	// believes the stamp): local for this computer, edge when the request as it arrived names a public Host or carries a proxy's headers
	// (checked here: the Workers runtime adds cf-connecting-ip and x-forwarded-host to everything). Both views: the plugin reads rawHeaders.
	const stamp = (req: any) => { const rh: string[] = req.rawHeaders ?? [], host = String(req.headers.host ?? "").replace(/:\d+$/, "");
		const v = LOOPBACK.test(host) && !PROXY_MARKS.some(h => h in req.headers) ? "local" : "edge";
		for (let i = rh.length - 2; i >= 0; i -= 2) if (String(rh[i]).toLowerCase() === "x-kitebook-ingress") rh.splice(i, 2);
		rh.push("x-kitebook-ingress", v); req.headers["x-kitebook-ingress"] = v; };
	server.middlewares.use((req, res, next) => { if (!refuse(req.url ?? "/")) { stamp(req); return next(); } res.statusCode = 404; res.setHeader("content-type", "text/plain"); res.end("not found\n"); });
} });

export default defineConfig({
	define: { __KITEBOOK_BUILD__: JSON.stringify(BUILD) },
	plugins: [workerOnlyPlugin(), cloudflare({ persistState: { path: DATA }, ...(process.env.KITEBOOK_INSPECTOR === "off" ? { inspectorPort: false } : {}) })], // smoke turns the inspector off so parallel runs don't fight over :9229
	// one bundle file: Better Auth loads some modules lazily (import()), and plain workerd (selfhost/config.capnp) embeds a single index.js.
	// A dynamic import() still defers evaluation inside that one file (src/auth-lib.ts: the Better Auth stack runs on first sign-in only).
	// Minified (911 -> ~690 KB gzip; less for workerd to parse on a cold start), with a source map for stack traces. keepNames: the WebAuthn
	// stack (@peculiar/asn1-schema) and better-call compare constructor/class names (e.g. "Sequence", "APIError"), so mangling them would break
	// passkey attestation parsing. `bun scripts/bundle-size.ts` shows what's inside.
	cacheDir: process.env.KITEBOOK_VITE_CACHE || undefined, // smoke.sh: each run its own (the default node_modules/.vite is shared through a symlinked node_modules)
	build: { minify: true, rolldownOptions: { output: { codeSplitting: false, keepNames: true } } },
	server: { port: Number(process.env.PORT ?? 5173), strictPort: true, host: "127.0.0.1", allowedHosts: (process.env.KITEBOOK_ALLOWED_HOSTS ?? "").split(",").filter(Boolean),
		fs: { strict: true, deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/.dev.vars", "**/.relay-data/**", "**/.cloudflare/**", "**/*.sqlite*"] } },
});
