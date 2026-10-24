# Self-host Kitebook on plain workerd (no Cloudflare account), with everything on local disk:
#   Durable Objects (spaces, tasks, small files) -> .relay-data/do      big/binary blobs -> .relay-data/blobs/<sha256>
# Run from the repo root:
#   npm install && npx cf build                         # bundles src/ to .cloudflare/output/v0/workers/default/bundle/index.js
#   mkdir -p .relay-data/do .relay-data/blobs
#   KITEBOOK_ADMIN_TOKEN=$(openssl rand -hex 24) npx workerd serve selfhost/config.capnp --experimental
# Override paths/port without editing: --directory-path relay-do=/srv/kitebook/do --directory-path relay-blobs=/srv/kitebook/blobs --socket-addr http=127.0.0.1:7820
# Two listeners, both on 127.0.0.1 (src/ingress.ts):
#   http (7820)  local: this computer's runner, its coding agents and its own browser (the dashboard). Never point a tunnel or proxy here.
#   edge (7821)  public: point the tunnel or reverse proxy (TLS) here and only here. It serves /mcp, /v1, OAuth and /health; with the
#                ingress lockdown on (the default for a new install) the dashboard, Settings and /admin answer 404 without the owner's session.
#   Each socket stamps x-kitebook-ingress on every request (workerd drops any value the client sent), and INGRESS_STAMPED tells Kitebook
#   to believe it. Move both with --socket-addr http=127.0.0.1:<port> --socket-addr edge=127.0.0.1:<port>.
# The proxy must send X-Forwarded-Proto: https (cloudflared does), which Kitebook takes as the visitor's https address (src/index.ts publicRequest).
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "kitebook", worker = .kitebook),
    (name = "relay-do", disk = (path = "../.relay-data/do", writable = true)),
    # Blob store: workerd serves GET/PUT/DELETE under this folder. Kitebook names files by sha256, so backups/copies are plain file copies.
    (name = "relay-blobs", disk = (path = "../.relay-data/blobs", writable = true)),
  ],
  sockets = [
    (name = "http", address = "127.0.0.1:7820", http = (injectRequestHeaders = [(name = "x-kitebook-ingress", value = "local")]), service = "kitebook"),
    (name = "edge", address = "127.0.0.1:7821", http = (injectRequestHeaders = [(name = "x-kitebook-ingress", value = "edge")]), service = "kitebook"),
  ],
);

const kitebook :Workerd.Worker = (
  modules = [ (name = "index.js", esModule = embed "../.cloudflare/output/v0/workers/default/bundle/index.js") ],
  compatibilityDate = "2026-10-06",
  durableObjectNamespaces = [
    (className = "Space", uniqueKey = "relay-Space", enableSql = true),
    (className = "Dir", uniqueKey = "relay-Dir", enableSql = true),
  ],
  durableObjectStorage = (localDisk = "relay-do"),
  bindings = [
    (name = "SPACE", durableObjectNamespace = "Space"),
    (name = "DIR", durableObjectNamespace = "Dir"),
    (name = "ADMIN_TOKEN", fromEnvironment = "KITEBOOK_ADMIN_TOKEN"),
    (name = "BLOB_STORE", text = "disk"),
    (name = "BLOB_DISK", service = "relay-blobs"),
    # S3 instead (MinIO, Backblaze B2, AWS): drop the two lines above and set
    #   (name = "BLOB_STORE", text = "s3"), (name = "S3_ENDPOINT", text = "https://..."), (name = "S3_BUCKET", text = "kitebook"),
    #   (name = "S3_ACCESS_KEY_ID", fromEnvironment = "S3_ACCESS_KEY_ID"), (name = "S3_SECRET_ACCESS_KEY", fromEnvironment = "S3_SECRET_ACCESS_KEY"),
    (name = "KITEBOOK_TITLE", text = "Kitebook"),
    (name = "INGRESS_STAMPED", text = "1"), # both sockets above stamp x-kitebook-ingress; remove only together with those stamps
    # OAUTH_DCR unset: Pi / Codex / Claude Code sign themselves up as public clients with loopback redirects, and Claude.ai /
    # ChatGPT with their client secret on their own https callbacks (safe: only your approval on the consent page gives access).
    # Add (name = "OAUTH_DCR", text = "1") for every other client with a secret, or text = "0" to turn sign-up off (then connect CLIs from /start).
  ],
);
