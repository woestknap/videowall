# Production signaling deployment

## Topology

Production uses one stable public WebSocket origin:

```text
editor and Pi browsers
        │ WSS signaling only
        ▼
wss://signal.example.com
        │ Cloudflare named tunnel (HTTPS/WSS termination)
        ▼
http://localhost:8787
        │
        ▼
Node signaling service on the Windows host

editor browser ───────── direct WebRTC media ─────────► Pi browsers
```

The hostname is an example, not a value to hard-code. The named tunnel terminates public TLS and forwards WebSocket traffic to the local Node service. It does not relay WebRTC media, replace Supabase, provide TURN, or bypass authentication. The signaling service still validates the editor access token and player device token, enforces device-scoped sessions, origin checks, message limits, and capacity limits. Treating the tunnel URL as secret is not an authorization mechanism.

## Environment separation

### Browser-safe Cloudflare Pages variables

Configure these separately under **Preview** and **Production** in Cloudflare Pages:

| Variable | Preview | Production |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | Public Supabase project URL | Public Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Public anon key | Public anon key |
| `VITE_SIGNALING_URL` | Stable preview-compatible `wss://` URL | `wss://signal.example.com` |
| `VITE_WEBRTC_STUN_URLS` | Comma-separated STUN URLs or empty | Comma-separated STUN URLs or empty |

Vite variables are browser-visible. Never place `SUPABASE_SERVICE_ROLE_KEY` or any other server credential in Pages or in a `VITE_` variable.

The Pages origin itself must also be listed in the signaling host's `SIGNALING_ALLOWED_ORIGINS`. Preview examples might include `https://feature-live-signaling.videowall-3lp.pages.dev`; production might include `https://videowall-3lp.pages.dev` or a custom domain. Configure actual trusted origins rather than copying examples blindly.

### Signaling-host-only variables

Keep these only in the Windows signaling service environment:

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL` | Supabase project used for server-side token validation and lease RPCs |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only credential; never browser-visible |
| `SIGNALING_HOST` | Local bind address, normally `0.0.0.0` |
| `SIGNALING_PORT` | Local port, normally `8787` |
| `PUBLIC_SIGNALING_URL` | Stable externally reachable URL written into Pi discovery leases |
| `SIGNALING_ALLOWED_ORIGINS` | Required comma-separated exact `http://` or `https://` editor origins |
| `SIGNALING_MAX_CONNECTIONS` | Positive connection capacity limit |
| `SIGNALING_MAX_SESSIONS` | Positive live-session capacity limit |

`PUBLIC_SIGNALING_URL` is the server-side source of truth. The service publishes it through `create_live_session_lease`; it is never derived from request headers or client input. Production should use `wss://signal.example.com`. Wildcard origins are rejected.

## Local development

Cloudflare is not required for local work. Copy `.env.example` to `.env`, use the laptop's reachable LAN address when Pis participate, and start both processes:

```text
VITE_SIGNALING_URL=ws://192.168.1.50:8787
PUBLIC_SIGNALING_URL=ws://192.168.1.50:8787
SIGNALING_ALLOWED_ORIGINS=http://localhost:5173,http://192.168.1.50:5173
```

```sh
npm run signaling
npm run dev
```

For laptop-only testing, `ws://localhost:8787` is sufficient. A Cloudflare quick tunnel can still be used deliberately for temporary testing, but its random hostname must be set explicitly in both `VITE_SIGNALING_URL` and `PUBLIC_SIGNALING_URL`; it is not the production design.

## Production startup order

1. In Cloudflare **Networking → Tunnels**, create a named tunnel and add a **Published application** route from the chosen `signal` hostname to `http://localhost:8787`.
2. On the Windows host, open Command Prompt as administrator and install the remotely managed tunnel using the token command supplied by Cloudflare: `cloudflared.exe service install <TUNNEL_TOKEN>`. Never commit that token.
3. Configure the server-only environment on the Windows host.
4. Start `npm run signaling` and confirm it reports the bind address, public URL, allowlisted-origin count, and capacities without printing credentials.
5. Confirm the `cloudflared` Windows service is running and the public hostname accepts a WebSocket upgrade from an allowed Pages origin.
6. Configure and redeploy Pages Preview/Production with their browser-safe variables.
7. Start a live session and confirm each Pi receives the stable `wss://` URL in its lease and establishes direct WebRTC media.

Both the Node process and `cloudflared` must survive terminal closure and Windows reboot. Configure `cloudflared` as a Windows service separately. Run the Node process under an appropriate Windows service manager or scheduled startup mechanism as a separate infrastructure step; this repository intentionally does not add PM2, NSSM, or service installation scripts.

## Troubleshooting

- **Service exits immediately:** read the named configuration error. `PUBLIC_SIGNALING_URL`, `SIGNALING_ALLOWED_ORIGINS`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY` are required. URLs and positive numeric limits are validated before listening.
- **Browser receives `origin-rejected`:** add the exact editor page origin, without a path, to the comma-separated allowlist and restart the service. Do not use `*`.
- **Pi never opens signaling:** inspect the token-protected player state and confirm its lease contains the stable public `wss://` URL and has not expired.
- **Tunnel returns an upstream error:** confirm the Node service is listening on the configured local host/port and the named tunnel forwards to `http://localhost:8787`.
- **Signaling connects but media does not:** inspect WebRTC/ICE diagnostics. Cloudflare transports signaling only; it is not a media relay or TURN server.
- **Preview works but production fails:** compare the four Pages variables and ensure both exact Pages origins are allowlisted on the signaling host.
- **Authentication fails:** verify the Supabase project and server-only service-role key belong together. Never paste access tokens, device tokens, SDP, ICE candidates, or service-role credentials into logs.

The signaling protocol retains its 64 KiB message limit, strict message schema, connection/session capacities, authenticated editor JWT validation, player device-token validation, and device-scoped routing. Offers, answers, candidates, access tokens, device tokens, and the service-role key are not logged.
