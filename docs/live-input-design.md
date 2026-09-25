# Live input design

## Status and boundary

LIVE-05A and LIVE-05B are complete. LIVE-06 implements editor fanout and is ready for multi-Pi hardware acceptance. One editor reuses its video-only camera preview stream across one authenticated, device-scoped `RTCPeerConnection` per targeted player. Each player keeps its received stream in memory by `liveSourceId` and renders it through the normal live-layer geometry. Supabase stores only expiring discovery leases, and the WSS service relays only signaling metadata. TURN and broader recovery remain future work.

A live-source definition and a live session remain different things: scene JSON may identify the source, but it must never contain a `MediaStream`, SDP, ICE candidates, peer connections, player credentials or session secrets.

## Existing trust and delivery model

The browser bundle creates one Supabase client with the public project URL and anon key.

- The dashboard and editor run behind Supabase email/password authentication. In the current single-admin schema, RLS lets any `authenticated` user manage every wall, device, scene, pairing PIN and wall-state row. `create_pairing_pin` additionally rejects calls without `auth.uid()`.
- A player does not have a Supabase Auth user session. It calls the anon-accessible `claim_pairing_pin` RPC with a valid, unclaimed, unexpired six-digit PIN. The security-definer function creates a device with a random UUID `player_token`, marks the PIN claimed and returns `{id, token}`.
- The player stores that pair in `localStorage` under `videowall-device`. On each four-second refresh it passes both values to the security-definer `get_player_state` RPC. That function accepts the player only when device ID and token match, then returns the active scene and wall device rectangles. `player_heartbeat` applies the same match before updating presence and dimensions.
- The player normally discovers published changes through that poll. It has no direct table access and no authenticated Realtime identity. A six-hour page reload and transient network failures are already normal parts of its lifecycle.

The device token is therefore a long-lived bearer credential. Its database-generated UUID and device-ID match let a trusted server establish possession, but it has no expiry, audience, wall claim or independent Supabase Auth identity. Theft of the `localStorage` pair permits player impersonation until that device is removed (the current revocation path) or a future mechanism changes its token. The token is suitable only as input to a server-side authorization check over TLS; it is not automatically available to Realtime channel authorization or RLS. A channel name containing a wall, device or random session ID is routing, not authorization.

## Signalling options

WebRTC media must travel directly between the editor browser and player (or through TURN when necessary). Signalling carries only session control, SDP and ICE candidates.

| Option | Fit with current authentication | Complexity and latency | Cleanup and isolation | Infrastructure, Pi and cost | Decision |
| --- | --- | --- | --- | --- | --- |
| **A. Supabase Realtime Broadcast** | Natural for the signed-in editor, but not for the anonymously connected player. Private-channel policies are based on a Supabase Auth identity; the existing device ID/token pair is validated only inside RPCs. Public channels or unguessable topics would not prevent subscription or spoofing. Minting a short-lived Supabase JWT for each Pi would require a trusted issuer/service anyway. | Low message latency and little client code after secure admission exists. Without that admission layer, the apparent simplicity is misleading. | Broadcast is ephemeral, which suits SDP/ICE, but the application still needs participant binding, expiry, rate limits and reconnect rules. A shared wall channel would leak negotiations between devices. | No separate socket host, and the JS client already exists. Realtime usage grows with every peer and candidate. Pi compatibility is good, but only after solving identity safely. | **Not V1.** Reconsider if players later receive short-lived, wall/device-scoped Auth JWTs and private-channel policies. |
| **B. Database rows plus Postgres Changes** | Token-checked security-definer RPCs could write/read rows for a player. Direct Realtime subscriptions still have the same anonymous-player authorization mismatch unless rows are exposed too broadly or a scoped Auth identity is added. | Durable row writes and change delivery are unnecessary overhead for negotiation. Polling the rows avoids subscription auth but adds latency and database traffic, especially for trickled ICE candidates. | Requires TTL deletion, retry/idempotency rules and strict per-device filtering. SDP and candidates would persist in backups/logging paths and expand the privacy surface. | Uses existing Supabase infrastructure but turns bursty ephemeral signalling into database workload. Browser compatibility is straightforward; operational cleanup is not. | **Reject for signalling messages.** A small expiring row is acceptable only as player discovery metadata. |
| **C. Small dedicated signalling endpoint/service** | The service can validate the editor's Supabase access token and separately validate a Pi's device ID/token through a narrowly scoped security-definer RPC. It then binds each socket to one role, wall and device before accepting messages. | Adds one small service, but gives direct, low-latency WebSocket routing and keeps the authentication adapter explicit. No media passes through it. | Ephemeral in-memory sessions, leases and participant-specific routing provide clean isolation. Disconnect and expiry cleanup do not depend on deleting candidate rows. | Requires a reachable HTTPS/WSS deployment and basic monitoring. Bandwidth and compute are tiny relative to media because only signalling crosses it. Standard browser WebSocket/WebRTC APIs work in Pi Chromium. | **Recommended for V1.** It fits the current split between admin JWTs and custom player credentials without making either credential public. |

### V1 choice

Use a thin dedicated WSS signalling service, with Supabase retained for durable application data and initial session discovery. Do not send video through Supabase, the signalling service or the player-state poll. Do not give a browser a service-role key.

The service should validate credentials rather than copy the database's authorization rules into client code:

1. The editor opens WSS and sends its current Supabase access token in the first encrypted authentication frame, never in the URL. The service verifies the token and confirms access to the requested wall. Under the present schema, any authenticated user is the administrator; the check must remain explicit so per-wall membership can replace it later.
2. The player opens WSS only for an announced live session and sends its device ID and token in the first encrypted authentication frame. A new narrowly scoped Supabase RPC should validate that pair and return only the device's wall ID. The service immediately discards the raw token and uses a connection-scoped principal thereafter.
3. No signalling message is routed before authentication. The service derives `from`, wall and device from the authenticated connection rather than trusting those fields from the client.

Reusing `get_player_state` as the service's credential check would prove the token but returns more scene data than an authentication adapter needs. A dedicated RPC is a smaller privilege boundary. Its implementation belongs to LIVE-05A, not this design change.

## Session and discovery model

A persisted live source identifies intended content; an ephemeral live session identifies one attempt to connect that source to one player. The server generates the session ID from at least 128 bits of cryptographic randomness.

```text
Live session
  sessionId          random, opaque identifier
  wallId             wall authorized for both participants
  liveSourceId       source referenced by the scene layer
  controllerUserId   authenticated editor user
  controllerConnId   current editor socket
  targetDeviceId     one paired Pi for LIVE-05
  generation         negotiation attempt number
  createdAt/expiresAt
  state              announced | negotiating | connected | ending
```

For V1, reuse the existing four-second player poll for discovery. Add an expiring announcement associated with the target device and include its non-secret descriptor in the token-protected `get_player_state` response. The row may hold `sessionId`, `wallId`, `liveSourceId`, `targetDeviceId`, signalling service URL and expiry, but never SDP, ICE candidates or either participant's credential. A stale announcement is ignored after `expiresAt` even if cleanup has not run.

This keeps idle players on their existing polling path and opens a signalling socket only while needed. The extra database record is a discovery lease, not a database signalling bus. Creation, RPC projection and cleanup are implementation work for LIVE-05A. If the four-second startup delay proves unacceptable after measurement, a permanently authenticated player socket can replace discovery later without changing the message protocol.

The editor requests a session only for a live source and target device belonging to the selected wall. The service creates the lease after authorization. When the player next sees it, the player connects to WSS and authenticates; the service confirms that the socket's device, wall and session match the lease.

## Signalling protocol

Use a versioned JSON envelope with strict schema and size limits. `wallId`, `from` and `to` shown below are service-derived routing metadata; clients must not be able to override them.

```text
{
  version: 1,
  type: "ready" | "offer" | "answer" | "ice-candidate" | "end",
  sessionId,
  liveSourceId,
  generation,
  payload
}
```

- `ready`: player to editor after socket authorization. Payload may advertise only capabilities needed for the proof of concept, such as video receive support.
- `offer`: editor to the one target player; payload contains the local SDP offer.
- `answer`: target player to editor; payload contains the remote SDP answer.
- `ice-candidate`: either participant to the other; payload contains `candidate`, `sdpMid` and `sdpMLineIndex`. A null candidate can mark end-of-candidates.
- `end`: either participant or the service; payload contains a bounded reason code such as `controller-stopped`, `player-left`, `expired` or `replaced`. It must not contain arbitrary diagnostic data.

Trickle ICE begins after the local description is set. The service forwards only to the other participant in the exact session and generation. It rejects an offer from a player, an answer from an editor, a message for a different device/wall/source, stale generations, duplicate controllers and messages after `end`.

An implementation may call its internal route `live:<sessionId>`, but clients do not join a public or wall-wide channel. The opaque ID is defense in depth; authenticated participant binding is the actual isolation mechanism.

## WebRTC peer flow

1. The editor already owns the camera `MediaStream`. For every targeted device it creates an independent `RTCPeerConnection`, adds the same video track, creates an offer and sends it only after that device reports `ready`.
2. Each player creates one receive-only peer connection, applies its offer, creates an answer and exposes the received stream to the existing live-layer renderer.
3. Both sides trickle ICE candidates through WSS. Browser-native WebRTC performs encoding, packetization, congestion control and decoding; application JavaScript must not process or relay frames.
4. Once ICE/connection state reaches `connected`, authenticated socket heartbeats keep the in-memory participant connections current; the service renews the database discovery lease only while the controller is active. A player alone cannot keep a controller session alive. Explicit stop, camera-track end, replacement by another session or terminal peer failure sends `end` and closes tracks, peer connection and socket.

For the Pi proof of concept, capture video only and start conservatively at no more than 1280×720 at 30 fps. Codec selection should be left to Chromium negotiation, with H.264 and VP8 behavior measured on the actual Pi 3/Pi 4 kiosk images. Do not assume hardware decoding merely because a codec is advertised. Autoplay should use `playsInline`; no audio track avoids autoplay and echo concerns already outside V1.

### End-to-end V1 sequence

1. The editor enables the existing local camera preview; capture remains unchanged.
2. The authenticated editor asks the signalling service to start one session for each device selected by the live layer's targeting.
3. The service authorizes each request and creates an independent short-lived discovery announcement.
4. Each target Pi learns of only its own session on its normal `get_player_state` poll, opens WSS and authenticates its device ID/token.
5. The service binds each editor/player socket pair to its device-scoped session; each Pi creates its receive-only peer connection and sends `ready`.
6. The editor creates that target's peer connection, adds the shared camera video track, sets its local offer and sends `offer`.
7. Each Pi applies its offer, creates and sets its answer, then returns `answer` through its own session.
8. Each pair exchanges trickled `ice-candidate` messages until WebRTC establishes a direct path. Every Pi receives a browser-native `MediaStream` directly from the editor.
9. An explicit stop ends all target sessions. A target-specific failure, replacement, disconnect or lease expiry cleans up that target without stopping the camera or other peers.
10. Both sides close their peer connection and socket, the player detaches its runtime stream, and the service expires that device's route and discovery announcement.

## Scene integration boundary

The player associates each received runtime `MediaStream` with its `liveSourceId` in memory, and the existing live layer resolves that stream. `SceneLayer` geometry, `content.liveSourceId`, device targeting and wall crop rules remain unchanged. Connection URLs, SDP, ICE and peer state never enter scene JSON.

## ICE, STUN and TURN

V1 targets an editor and Pi on the same routable LAN. Start with host candidates and one explicitly configured STUN service. STUN helps discover server-reflexive candidates but does not relay media. A STUN-only proof of concept is expected to fail on some guest Wi-Fi, client-isolated networks, restrictive firewalls, symmetric NATs or remote-network arrangements; that is an explicit V1 limitation, not a reason to put frames through signalling.

TURN becomes required when the peers cannot establish a direct path, especially for remote use or segmented networks. TURN configuration must be returned by a trusted endpoint, use short-lived scoped credentials and remain outside the static frontend bundle. Relay bandwidth, region and retention policy then become material operating costs. TURN should be added after the direct-LAN proof is measured, not silently represented as supported in V1.

## Lifecycle, reconnect and cleanup

Suggested initial values are a 60-second negotiation deadline, a 45-second renewable session lease and a short disconnect grace period. They are configuration, not scene data, and must be adjusted from Pi tests.

- **Editor reload/disconnect:** keep the discovery lease only for the grace period. If the editor returns and reauthorizes, increment `generation` and create a fresh peer connection. Otherwise end the session and remove/expire the announcement.
- **Player reload/disconnect:** its normal poll rediscovers an unexpired announcement. On `ready`, increment the generation and renegotiate from a new offer. Never reuse old SDP or candidates.
- **Camera stopped or removed:** editor sends `end`, closes the sender and its tracks, and clears the lease. The saved live layer/source remains unchanged.
- **Signalling service restart:** sockets disappear and in-memory negotiations are lost. Participants reconnect and renegotiate while the discovery lease is valid; no persistent candidate replay is required.
- **Duplicate session:** allow at most one active controller session per `(liveSourceId, targetDeviceId)` for V1. A new authorized session explicitly ends the old one.
- **Expiry:** the service closes idle sockets and all peer resources. Database cleanup may delete expired announcements asynchronously, but RPCs must filter them immediately.

Connection failures should be visible as bounded states such as waiting for player, negotiating, connected, direct connection unavailable and ended. They must not interrupt ordinary `get_player_state`, heartbeat, published-scene rendering or the player's six-hour recovery reload.

## Security requirements

- Require HTTPS/WSS outside localhost. Never place the admin JWT or player token in a URL, channel name, SDP, ICE message, error string or analytics event.
- Public Broadcast channels are not acceptable for offers, answers or candidates. If Supabase Realtime is reconsidered, the server must first mint a short-lived device/wall/session-scoped identity and private-channel policies must enforce both participants; topic secrecy is insufficient.
- Treat the player token like a password. Accept it only in the initial encrypted authentication frame, validate it server-side with a constant-shape response, discard it immediately and never log it. Rate-limit failures by connection and device ID.
- Keep any Supabase service-role key and TURN secret server-side. Prefer a narrow security-definer validation RPC over broad table access. Revoke/deny access by deleting or rotating the paired device token.
- Bind every session to its authorized wall, source, controller and one target device. Recheck membership when the session is created and when the player authenticates. Do not rely on the session ID being hard to guess.
- Validate message type, role, generation, payload shape and maximum byte size. Cap candidates, offers, reconnect attempts and concurrent sessions. Reject binary frames and unexpected fields.
- Do not persist or routinely log SDP or ICE candidates; both may reveal local/network addresses. Operational logs should contain opaque session IDs, role, state transitions, timings and sanitized reason codes only.
- Configure allowed web origins at the signalling service. Origin checking supplements authentication; it does not replace it.
- A compromised paired player can receive only sessions explicitly targeted to its device, and a compromised controller session can signal only walls allowed by its Supabase identity.

## One-peer-per-Pi fanout

LIVE-06 creates one peer session per participating device under one logical source/controller action. Each peer has its own `sessionId`, target device, generation, SDP, ICE state and failure status. The editor adds the same captured video track to one `RTCPeerConnection` per Pi; signalling never broadcasts one device's SDP or candidates to another. Layer targeting is the source of truth. For V1, target changes while streaming require **End session → Save → Start live session** instead of live peer reconciliation.

This mesh is simple and lets each Pi decode only its stream, but the controller encodes/sends roughly one stream per player and uplink cost grows linearly. Measure editor CPU, outbound bitrate, connection setup time and Pi 3/Pi 4 decode stability before raising resolution or player count. If that cost becomes unacceptable, an SFU is a later topology decision; it is not part of V1 and must not change wall coordinates or layer targeting semantics.

## LIVE-05 implementation boundary

The proof of concept should be split so security and transport are independently reviewable:

1. **LIVE-05A — authorized signalling and discovery:** add the narrow player validation RPC, expiring discovery lease, player-state projection and dedicated WSS service with authenticated, isolated, expiring sessions. Prove `ready`/`end` and reconnect without media.
2. **LIVE-05B — one-editor/one-Pi WebRTC:** connect the existing editor camera stream to one paired Pi with `offer`, `answer` and trickle ICE; render it in an isolated player proof-of-concept surface and record Pi codec/resolution results.

Authorized discovery, direct one-player WebRTC and multi-player fanout are implemented. Broader reconnect and error recovery remain LIVE-08 work.

## Live input development smoke test

Use Node 24. Copy `.env.example` to `.env`. Browser values are `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_SIGNALING_URL` and the optional comma-separated `VITE_WEBRTC_STUN_URLS`; the signaling process additionally requires `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SIGNALING_PORT`, `PUBLIC_SIGNALING_URL` and `SIGNALING_ALLOWED_ORIGINS`. The service-role key is server-only. `ws://localhost:8787` is valid only for local development; deploy behind TLS and use `wss://` in production. An empty STUN list still permits LAN host candidates; TURN credentials are not supported in this phase.

Apply the migration to a linked development project with `npx supabase db push`, then run `npm run dev` and, in a second terminal, `npm run signaling`. Sign in to the editor, save a live layer that targets the intended paired displays, enable its camera preview and select **Start live session** once. The editor shows signalling, readiness, WebRTC and ICE state independently for every target. Within the players' normal four-second polls, each target Pi discovers its own lease, authenticates, sends `peer-ready`, negotiates WebRTC and renders the camera inside the saved live-layer geometry. `?player=1&debug=1` shows signalling, peer/ICE states and remote-track presence without changing playback.

First test two Pis, then four. Move and resize a live layer spanning screens and save/publish it to verify the same per-player crop and transforms used by other media. Disconnect one Pi and confirm the other streams remain active. Select **End session** in the editor to remove every lease, close every peer/socket and detach every remote stream. Stop the signaling service to verify that ordinary scene polling and non-live rendering continue despite a signaling error. Editor upload bandwidth and encoding work scale approximately linearly with the number of players; V1 is intended for a small personal wall of roughly four Pis and has no SFU or transcoding.
