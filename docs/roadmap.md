# Phased roadmap

These are planned tasks, not claims that future behavior already exists. Each item should be a separate scoped change. Preserve the [architecture](architecture.md) and [rendering model](rendering-model.md) unless that item explicitly changes them.

## Phase 0 — Structural baseline (completed)

- Split `App.tsx` into admin, editor, player and rendering modules. Acceptance: behavior-preserving module split with `App.tsx` limited to mode/auth composition.

## Phase 1 — Project documentation (current)

- Add `AGENTS.md` and architecture, rendering, editor, live-input and roadmap docs. Acceptance: all six files exist, describe current code accurately and label future design explicitly.

## Phase 2 — Editor UX (planned)

- **UI-01:** Reorganize editor layout. Acceptance: screen, canvas and property workflows are clearer while save, targeting, upload and drag behavior remain intact.
- **UI-02:** Improve initial wall fit and zoom. Acceptance: opening a scene frames participating screens usefully; wheel zoom, pan, Fit and Reset remain predictable.
- **UI-03:** Add clearer scene/source/layer hierarchy. Acceptance: layer identity, selection and order are visible without changing stored layer semantics.
- **UI-04:** Organize the inspector. Acceptance: media, placement and stacking controls are easier to find, with the same values and effects.

## Phase 3 — Dashboard UX (planned)

- **UI-05:** Improve dashboard information hierarchy and use of space. Acceptance: wall, scene, preview and publish state are easier to scan without changing actions.
- **UI-06:** Show the actual physical wall arrangement. Acceptance: screen rectangles reflect stored layout positions and relative sizes, including gaps, rather than equal cards.
- **UI-07:** Move destructive actions to secondary/context controls and clarify connection status. Acceptance: deletion remains available with confirmation; device status does not imply more than the existing heartbeat data proves.

## Phase 4 — Live source foundation (planned; no player transport)

- **LIVE-01:** Extend types/persistence for live-source references. Acceptance: scenes can reference a source without serializing browser streams or altering ordinary media layers.
- **LIVE-02:** Add Live Input to editor source/media UI. Acceptance: a source can be named, selected and assigned to a layer, with no claim of wall playback yet.
- **LIVE-03:** Enumerate local video devices. Acceptance: the editor can list available cameras after appropriate browser permission and handle unavailable devices.
- **LIVE-04:** Show local camera preview. Acceptance: the chosen camera previews in the editor and capture tracks stop cleanly when released.

## Phase 5 — WebRTC proof of concept (complete)

- **LIVE-05A:** Add authorized signalling and live-session discovery. Acceptance: the signed-in editor and one token-authenticated paired Pi can join only their short-lived, device-scoped session; discovery uses the existing player poll, realtime messages are isolated and ephemeral, and no video frames enter Supabase or normal state polling.
- **LIVE-05B:** Send one editor webcam stream to one paired Pi. Complete and verified on physical Pi hardware through the LIVE-05A signalling path.

## Phase 6 — Live wall integration (in progress)

- **LIVE-06:** Support multiple Pi peer connections. Implemented as one device-scoped session and direct peer connection per targeted Pi, reusing one camera stream; multi-Pi hardware acceptance and controller resource measurements remain.
- **LIVE-07:** Render live streams through `SceneLayer` placement. Acceptance: live layers obey the existing wall coordinates, device targeting and per-player crop.
- **LIVE-08:** Handle reconnect, errors and camera disconnect. Acceptance: failures are visible and recovery does not disrupt stored scenes or ordinary player polling.

## Phase 7 — Polish / future (planned)

- Consider multiple live sources, screen capture, an RTSP/network ingest gateway and OBS-style inputs. Acceptance: each source kind has an independently validated capture and playback path before wall integration.
- Revisit stream topology if the player count grows. Acceptance: measured browser-to-many-Pi costs justify a specific change; no SFU is assumed for V1.
