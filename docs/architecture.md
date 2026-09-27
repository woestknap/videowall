# Current architecture

## Runtime modes and ownership

| Module | Current responsibility |
| --- | --- |
| `src/App.tsx` | Query-string mode selection (`?player=1` takes precedence over `?editor=<scene-id>`), auth session gate, dashboard/editor choice. No routing library. |
| `src/admin/Admin.tsx`, `SignIn.tsx` | Dashboard wall, device, scene and publish actions; Supabase email/password sign-in. |
| `src/editor/SceneEditorPage.tsx`, `src/ScreenLayoutControls.tsx` | Scene/device loading and saving, reusable media selection, canvas interactions, inspector and screen measurements. Canvas and inspector still share one component. |
| `src/media/` | Shared Media Library management/picker UI, direct-to-R2 upload orchestration, metadata extraction, search/filter/sort, usage counting and guarded deletion. |
| `src/player/Player.tsx` | Pairing, local token, clock calibration, polling, heartbeat, kiosk refresh and diagnostic modes. |
| `src/rendering/` | `ScenePreview` viewport/cropping, `Layer` media selection, `SyncedVideo` playback correction, `Clock` display. |
| `src/lib/`, `src/types.ts` | Supabase client; wall geometry and editor zoom helpers; shared data types, including optional reusable media references. |
| `server/media/` | Authenticated, server-only R2 upload signing and scoped object deletion alongside the signaling HTTP listener. It never proxies media bytes. |

Normal root URL opens the admin dashboard after authentication; `?editor=<scene-id>` opens the editor after the same gate. `?player=1` runs the kiosk player without an admin session. If Supabase is unconfigured, the dashboard shows a configuration warning and the player shows a configuration message.

## Supabase and persisted state

- Auth uses a signed-in admin account. `walls`, `devices`, `scenes` and `wall_state` are persistent tables. `pairing_pins` holds temporary, expiring PIN records; device tokens are stored with devices.
- `scenes.layers` is JSONB; `device_ids` selects scene participants. Scenes now have an optional owning wall and an explicit geometry version. Existing rows remain version 1 with no automatic wall assignment or layer conversion. Version 2 reserves a persisted `canvas_width_px`, `canvas_height_px` and wall-geometry revision so future pixel geometry stays stable when wall calibration changes. Device layout fields hold wall rectangles in either measured units or viewport-based units. `wall_state` stores `active_scene_id`, `playback_mode` and `changed_at`. The current player-state RPC reads the active scene and change time; it does not branch on `playback_mode`. The dashboard publishes with `playback_mode: 'manual'`.
- Admin creates a PIN through `create_pairing_pin`. The player claims it through `claim_pairing_pin`, which creates a device and returns its ID and token. Token-authenticated `get_player_state` returns the current scene, wall device rectangles and scene start time; `player_heartbeat` updates presence/viewport (and automatic dimensions). `get_server_time` supplies the clock calibration endpoint.
- PIXEL-01 adds an optional virtual-wall geometry object to player state. Resolution-layout walls use their layout coordinates directly. Physical-layout walls require one wall-wide `virtual_pixels_per_mm`; physical size determines each virtual footprint while the reported Chromium viewport remains separate output-raster information. Mixed physical and resolution inputs return an explicit invalid result rather than being coerced. The PIXEL-02 player consumes this object only for `geometry_version = 2`, transforms one shared virtual-pixel plane from its assigned device region into the actual browser viewport, and fails safely when the V2 contract is incomplete. V1 remains the default. PIXEL-03A adds explicit V2 scene creation and virtual-pixel editor manipulation without migrating V1 scenes.
- `media_assets` is the reusable catalog for playback-ready files stored in Cloudflare R2. The dashboard manages it and the editor selects from it. Layers carry both `mediaAssetId` and the stable public `url`; URL-only legacy layers and the existing Supabase Storage bucket remain supported.

The dashboard's selected wall/scene, editor selection, unsaved edits, zoom/pan, notices, pairing form, player status and sampled clock offset are temporary browser state. The player keeps `{id, token}` in `localStorage` under `videowall-device`; the corresponding device/token record persists in Supabase. A saved scene is not live merely because it was edited: publishing updates `wall_state`.

## Lifecycles

1. **Player:** open `?player=1`; enter a dashboard PIN once; store the returned ID/token locally. On reconnect, reuse that token. The player samples server time, polls `get_player_state` every 4 seconds and calls `player_heartbeat` after successful state retrieval. It passes the scene, legacy device rectangles, optional virtual-wall geometry, calibrated offset and start time to `ScenePreview`. V1 scenes use the legacy percentage crop; valid V2 scenes use the normalized virtual device region without deriving footprint from viewport resolution. A six-hour page reload and animation-frame health signal support kiosk recovery.
2. **Scene:** choose legacy or virtual-pixel creation on the dashboard. Legacy scenes start with the existing starter layers; V2 creation requires a selected wall with valid virtual geometry and stores an empty scene with that canvas and revision. Open `?editor=<id>` to use the matching V1 percentage or V2 pixel editor path. V1 can still save screen layout separately; V2 device outlines are read from current wall geometry while its persisted canvas remains fixed. Publish/Go live updates `wall_state`. The next player poll receives the published scene. The editor's duration field is persisted, but the current dashboard publishes manually; this file does not imply an implemented cycle scheduler.

See [rendering model](rendering-model.md) for coordinate details and [kiosk guide](raspberry-pi-kiosk.md) for OS-level recovery.

Live input uses the dedicated authenticated WSS service described in [live input design](live-input-design.md). In production, a Cloudflare named tunnel exposes that signaling service at a stable hostname; it carries signaling only, while WebRTC media travels directly between the editor and each Pi. Deployment and environment ownership are documented in [production signaling deployment](production-signaling.md).

The same Node process exposes authenticated media control endpoints, while browser-to-R2 uploads and R2-to-player downloads stay direct. See [media library and Cloudflare R2](media-library.md) for the trust and storage boundaries.
