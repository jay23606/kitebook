# A stable address for your daily assistants

Your assistant needs a reachable HTTPS URL that its provider accepts. Once that address works, [give it to the assistant](how-to-use.md#1-give-your-assistant-your-kitebook-url); it can configure its connection where supported, and you approve access.

## Choose an address

| Option | When to use it |
| --- | --- |
| Built-in quick tunnel | Try Kitebook without an account or domain. The address can change when the tunnel restarts; SSE is unsupported. Check acceptance in the actual assistant. |
| Your domain + Cloudflare named tunnel | A stable address for daily use, or a fallback when a provider rejects shared tunnel hostnames. Follow the steps below. |
| Tailscale Funnel | A public HTTPS `ts.net` address, if your assistant accepts it. Private Tailscale Serve additionally needs tailnet access. |
| Existing hosted HTTPS server | Use that server's public address. You do not need a Mac tunnel for a server already deployed elsewhere. |

Hark rejected the owner's `ts.net` address in one setup. Muse's Tailscale plugin does not by itself establish that its MCP destination accepts `ts.net`. These are compatibility observations, not universal provider policies. [Evidence and alternatives](setup.md#address-compatibility-and-avoiding-a-domain).

## Use a domain with the built-in Mac server

You need an installed Kitebook, a Cloudflare account and a domain active in that account. You can use a subdomain of a domain you already own; a separate domain purchase is unnecessary. If you do not have one configured, follow [Cloudflare's domain onboarding](https://developers.cloudflare.com/fundamentals/manage-domains/add-site/) and complete the DNS/nameserver steps it gives you. Wait for the domain to become active before continuing. Domain registration has its own renewal cost.

### 1. Create the tunnel

Open the [Cloudflare dashboard](https://dash.cloudflare.com/), go to **Networking → Tunnels**, and create a remotely managed tunnel named, for example, `kitebook`. Older dashboards put this under **Zero Trust → Networks → Tunnels**. Cloudflare's [current tunnel walkthrough](https://developers.cloudflare.com/tunnel/get-started/) covers the dashboard screens.

Locate the tunnel's connector token in its setup instructions. **Use that token in Kitebook's Settings**, rather than running Cloudflare's separate service-install command: Kitebook already manages its tunnel connector. A tunnel token is different from a Cloudflare account API token. Keep it private; do not paste it into an assistant conversation or shared note.

### 2. Give Kitebook the token and hostname

Open Kitebook locally with `kitebook open`. Go to **Settings → Connection**, turn on public access if necessary, and expand **Keep the same address (optional)**.

- Paste the **tunnel connector token** into the token field.
- Enter `kitebook.example.com` as the hostname, without `https://` or `/mcp`.
- Press **Use my tunnel**. The connector can come online before the hostname is routed; finish the next step before testing the public address.

Kitebook stores the connector token privately on the Mac and manages the connector at login. It does not create Cloudflare DNS or application routes for you. Keep the Mac running and awake while its daily assistants need the server; a stable domain does not keep a sleeping Mac online.

### 3. Publish your hostname

In the tunnel, add a **Published application** route (older dashboards call this **Public Hostname**):

| Field | Example value |
| --- | --- |
| Subdomain | `kitebook` |
| Domain | `example.com` (your active domain) |
| Path | Leave empty, so pairing, OAuth, API and MCP routes all work |
| Service type | HTTP |
| Service URL | `127.0.0.1:7821` |

The resulting public address is `https://kitebook.example.com`. The local service uses HTTP; the public address uses HTTPS through Cloudflare. Save the route and check that its DNS record was created. An existing DNS record for that same subdomain may need resolving first.

**Use the public listener.** The default local dashboard is port **7820**; the tunnel forwards to **7821**. Settings shows the correct public-listener port for your installation. If you changed the server port, use the public port shown there (normally server port + 1, or your `KITEBOOK_EDGE_PORT` override). For a Docker connector in the same compose network, the target is `http://kitebook:7821`; `127.0.0.1` there would refer to the connector container itself.

### 4. Test from the daily assistant

Give Hark or Muse the public URL, or use **Copy connection request** in Settings. The assistant should fetch `/setup.md`, prefer its native integration (pair only when unavailable), show you its approval link, and verify `whoami` plus the MCP tools or HTTP API after approval. Then, with your permission, save a harmless note and have another assistant read it. [Full usage walkthrough](how-to-use.md).

A successful `/health` response only proves basic reachability. It does not prove authentication, provider acceptance, streaming, or credential persistence across a sandbox reset. Kitebook provides its own app authentication; an additional browser-only Access login/challenge can prevent an assistant from reaching the endpoint. If you use an additional access policy, verify that your assistant supports its authentication method.

## When it does not connect

| Symptom | Check |
| --- | --- |
| Hostname does not resolve | Domain is active; the hostname has the tunnel DNS record; DNS changes have propagated. |
| Cloudflare reports an unavailable tunnel | Mac is awake, connector token is correct, tunnel is working in Kitebook; run `kitebook logs tunnel`. |
| Tunnel is healthy but returns 502 | Application route uses HTTP and Kitebook's public port, normally `127.0.0.1:7821`; `kitebook status` reports the server running. |
| Health works but `/setup.md` returns a login page | An upstream access policy or challenge is intercepting the request. Verify compatibility from the assistant's environment. |
| Mac connects, assistant refuses the URL | Check the provider's hostname/network restrictions from that assistant. A Tailscale plugin alone is not proof of reachability. |
| Cloudflare returns HTTP 403 / error 1010 | Check the client's request headers. Muse's template should send `User-Agent: muse-custom-connector/1`; Python's default user agent was blocked in the owner's deployment. Preserve the stored credential, verify the corrected transport once, and report continued blocking to the owner. See [Cloudflare's explanation](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/). |
| Kitebook returns JSON 401 or 403 | Refresh/sign in again for 401; check the app's approved access for a permission 403. Do not repeatedly pair or broaden permissions automatically. |
| Old quick-tunnel URL stopped working | Copy the new stable address into the assistant's saved connection; authorize again if its host requires it. |

`kitebook mcp diagnose` separates network, TLS and sign-in failures **from the machine where it runs**. A Mac-side success cannot verify another platform's network policy. No router port forwarding is needed for the tunnel.
