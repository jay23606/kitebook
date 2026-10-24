// One secret detector for the whole system: the server's write guard and report redactor (src/space/util.ts), its KB guard (src/kb.ts), and
// the Mac's KB / outbox redactor (client/kb.ts) all use these lists, so they can't drift apart. No imports: the Worker bundles it and the
// runner gets it as a flat client/*.ts file.
// TOKEN_RES: token-shaped secrets (vendor prefixes and JWTs); a write that contains one is refused, a report has it replaced.
// redact() also blanks the password in URLs with credentials (postgres://user:pass@host) and the value of written-out assignments
// (password=..., api_key: ..., STRIPE_SECRET_KEY=... with a credential-looking value).
// The (?<![A-Za-z0-9]) guard keeps ordinary words ("risk-assessment-framework", "network_...") from matching a prefix.
import "./brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
export const B = "(?<![A-Za-z0-9])";
export const TOKEN_RES: RegExp[] = [
  new RegExp(B + "(?:AKIA|ASIA)[0-9A-Z]{16}"),                        // AWS access key id
  new RegExp(B + "gh[pousr]_[A-Za-z0-9]{30,}"),                       // GitHub classic / OAuth / app tokens
  new RegExp(B + "github_pat_[A-Za-z0-9_]{40,}"),                     // GitHub fine-grained PAT
  new RegExp(B + "glpat-[A-Za-z0-9_-]{20,}"),                         // GitLab
  new RegExp(B + "sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}"),             // OpenAI / Anthropic
  new RegExp(B + "(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}"),         // Stripe secret / restricted
  new RegExp(B + "xox[abposr]-[A-Za-z0-9-]{10,}"),                    // Slack tokens
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_/-]{20,}/,       // Slack webhook URL
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  new RegExp(B + "AIza[0-9A-Za-z_-]{35}"),                            // Google API key
  new RegExp(B + "npm_[A-Za-z0-9]{36}"),                              // npm
  new RegExp(B + "dop_v1_[a-f0-9]{64}"),                              // DigitalOcean
  new RegExp(B + "shp(?:at|ss|ca|pa)_[a-fA-F0-9]{32}"),               // Shopify
  new RegExp(B + "hf_[A-Za-z0-9]{30,}"),                              // Hugging Face
  new RegExp(B + "eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{10,}"), // JWT (header.payload.signature)
  new RegExp(B + "rk_[A-Za-z0-9_-]{32}"), new RegExp(B + "(?:rk|ak)\\.[a-z0-9-]+\\.[A-Za-z0-9_-]{32}"), // Kitebook's own peer / account keys
];
// postgres://user:pass@host, https://x:token@github.com: the user stays, the password goes
export const URL_CRED_RE = /\b([a-z][a-z0-9+.-]{1,20}:\/\/[^\s/:@"'`]{1,128}):(?!\[REDACTED\])[^\s/@"'`]{1,256}@/gi;
// password: hunter2!, api_key="...", client_secret=...: the value must look like a credential (a digit or symbol), so
// "password: stored in the keychain" is fine; "[REDACTED]" is what clients send instead
export const ASSIGN_RE = /(\b(?:pass(?:word|wd|phrase)?|pwd|passcode|secret|api[_-]?key|access[_-]?key|auth[_-]?token|access[_-]?token|private[_-]?key|client[_-]?secret|aws_secret_access_key)\b["']?\s*[:=]\s*["']?)(?!\[REDACTED\])(?=[^\s"'`]*[0-9!@#$%^&*+_-])[^\s"'`]{6,}/gi;
// FOO_API_KEY=..., STRIPE_SECRET=..., DB_PASSWORD=... (env / .env lines; "_" is a word character, so ASSIGN_RE's \b misses these): a value
// of 16+ characters with letters and digits (high entropy, not a word or a path)
export const ENV_RE = /(\b[A-Za-z][A-Za-z0-9_]*(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_PASSWD|_PASS|_PAT|_CREDENTIALS?)\b["']?\s*[:=]\s*["']?)(?!\[REDACTED\])([A-Za-z0-9/+_.=-]{16,})/g;
const entropic = (v: string) => /[A-Za-z]/.test(v) && /[0-9]/.test(v) && new Set(v).size >= 10;

export const hasToken = (s: string) => TOKEN_RES.some(r => r.test(s));
export const hasAssignment = (s: string) => new RegExp(ASSIGN_RE.source, "i").test(s) || [...s.matchAll(new RegExp(ENV_RE.source, "g"))].some(m => entropic(m[2]));
export const redact = (s: string) => TOKEN_RES.reduce((t, r) => t.replace(new RegExp(r.source, "g"), "[REDACTED]"),
  String(s).replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[REDACTED]")) // the whole key block, before the header rule
  .replace(URL_CRED_RE, "$1:[REDACTED]@").replace(ASSIGN_RE, "$1[REDACTED]").replace(ENV_RE, (m, k, v) => entropic(v) ? k + "[REDACTED]" : m);
// Logs kept for Experimental's recent logs (src/devlog.ts on the server, client/devlog.ts on the Mac): redact() plus what log lines carry and files don't:
// Authorization / Cookie / Set-Cookie header values, bearer tokens, ?token= / &code= style query values, Kitebook OAuth tokens
// (at./rt./ac.<acct>.<secret>), invite codes, long hex/base64 blobs right after key-ish words, emails (optional), and any value we know is a
// secret (runner.json token, ntfy token, the server's env / .dev.vars values: `known`, 8+ chars).
export function redactLog(s: string, known: string[] = [], o: { emails?: boolean } = {}): string {
  let t = String(s ?? "");
  for (const k of [...new Set(known.map(String))].filter(k => k.length >= 8).sort((a, b) => b.length - a.length)) t = t.split(k).join("[REDACTED]");
  t = redact(t)
    .replace(/\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)(["']?\s*[:=]\s*["']?)(?!\[REDACTED\])[^\n"']{1,4000}/gi, "$1$2[REDACTED]")
    .replace(/\b(bearer|basic)\s+(?!\[REDACTED\])[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]")
    .replace(/([?&](?:token|access_token|refresh_token|code|code_verifier|client_secret|password|key|sig|signature|secret)=)(?!\[REDACTED\])[^&\s"'#]+/gi, "$1[REDACTED]")
    .replace(new RegExp(B + "(?:at|rt|ac|rk|ak)\\.[a-z0-9-]+\\.[A-Za-z0-9_-]{16,}", "g"), "[REDACTED]")
    .replace(new RegExp(B + "inv_[A-Za-z0-9_.-]{12,}", "g"), "[REDACTED]")
    .replace(/(\b(?:token|secret|key|session|cookie|sig|signature|nonce)\b["']?\s*[:=]\s*["']?)(?!\[REDACTED\])[A-Za-z0-9_+/=.-]{20,}/gi, "$1[REDACTED]")
    .replace(/((?:better-auth|relay|kitebook)[._-][a-z0-9_.-]*=)(?!\[REDACTED\])[^;\s"']+/gi, "$1[REDACTED]");
  if (o.emails !== false) t = t.replace(/\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}\b/g, "[EMAIL]");
  return t;
}
