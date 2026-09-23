# Planned live input design — not implemented

## V1 goal and boundaries

An editor browser captures a webcam or other local camera and makes its live video available as a scene layer across the wall. This is a design for future work: the current `LayerType` has no `live` member, no live-source persistence exists, and the player has no WebRTC path. Normal application persistence remains in Supabase.

The proposed model adds a generic `live` layer type alongside `image`, `video`, `clock`, `text` and `ticker`. A persisted `LiveSource` could contain an ID, name, kind and device identifier/configuration; a `SceneLayer` would reference that source ID. Source definition and live connection/session state are separate. Never store `MediaStream`, `RTCPeerConnection` or encoded frames in scene JSON. Browser device identifiers and capture permission must be handled as browser-local concerns; a persisted identifier alone is not a live connection.

## Intended transport

1. The editor browser selects a local camera and calls `getUserMedia`, then shows a local preview.
2. It negotiates a WebRTC connection with a paired Pi. Supabase Realtime/Broadcast is a signalling candidate to evaluate; do not send video frames or base64 chunks through ordinary database polling.
3. The Pi receives a `MediaStream` over the peer connection and renders it as the live layer. Once received, the layer uses the existing wall placement, targeting, projection and crop model, including spanning displays.

The first proof of concept is one editor browser, one webcam and one Pi player, isolated from full scene integration. Only after that works should the transport expand to multiple Pis. A browser-to-player mesh sends one peer stream per Pi; acceptable for an initially small personal wall, but sender bandwidth and device capacity need re-evaluation if player count grows. No SFU or streaming server is planned for V1.

Additional webcams, screen capture, external network streams, OBS-type inputs and an RTSP gateway are possible later source kinds, not V1 requirements. See [roadmap](roadmap.md) for implementation phases.
