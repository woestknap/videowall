# Current architecture

## Runtime modes and ownership

| Module | Current responsibility |
| --- | --- |
| `src/App.tsx` | Query-string mode selection (`?player=1` takes precedence over `?editor=<scene-id>`), auth session gate, dashboard/editor choice. No routing library. |
| `src/admin/Admin.tsx`, `SignIn.tsx` | Dashboard wall, device, scene and publish actions; Supabase email/password sign-in. |
| `src/editor/SceneEditorPage.tsx`, `src/ScreenLayoutControls.tsx` | Scene/device loading and saving, media upload, canvas interactions, inspector and screen measurements. Canvas and inspector still share one component. |
| `src/player/Player.tsx` | Pairing, local token, clock calibration, polling, heartbeat, kiosk refresh and diagnostic modes. |
| `src/rendering/` | `ScenePreview` viewport/cropping, `Layer` media selection, `SyncedVideo` playback correction, `Clock` display. |
| `src/lib/`, `src/types.ts` | Supabase client; wall geometry and editor zoom helpers; shared data types. |

Normal root URL opens the admin dashboard after authentication; `?editor=<scene-id>` opens the editor after the same gate. `?player=1` runs the kiosk player without an admin session. If Supabase is unconfigured, the dashboard shows a configuration warning and the player shows a configuration message.

## Supabase and persisted state

- Auth uses a signed-in admin account. `walls`, `devices`, `scenes` and `wall_state` are persistent tables. `pairing_pins` holds temporary, expiring PIN records; device tokens are stored with devices.
- `scenes.layers` is JSONB; `device_ids` selects scene participants. Device layout fields hold wall rectangles in either measured units or viewport-based units. `wall_state` stores `active_scene_id`, `playback_mode` and `changed_at`. The current player-state RPC reads the active scene and change time; it does not branch on `playback_mode`. The dashboard publishes with `playback_mode: 'manual'`.
- Admin creates a PIN through `create_pairing_pin`. The player claims it through `claim_pairing_pin`, which creates a device and returns its ID and token. Token-authenticated `get_player_state` returns the current scene, wall device rectangles and scene start time; `player_heartbeat` updates presence/viewport (and automatic dimensions). `get_server_time` supplies the clock calibration endpoint.
- The editor uploads files to the public `media` storage bucket and puts the returned URL into a layer only in browser state until the scene is saved. Players read public media URLs without an admin session.

The dashboard's selected wall/scene, editor selection, unsaved edits, zoom/pan, notices, pairing form, player status and sampled clock offset are temporary browser state. The player keeps `{id, token}` in `localStorage` under `videowall-device`; the corresponding device/token record persists in Supabase. A saved scene is not live merely because it was edited: publishing updates `wall_state`.

## Lifecycles

1. **Player:** open `?player=1`; enter a dashboard PIN once; store the returned ID/token locally. On reconnect, reuse that token. The player samples server time, polls `get_player_state` every 4 seconds and calls `player_heartbeat` after successful state retrieval. It passes the scene, device rectangles, calibrated offset and start time to `ScenePreview`. A six-hour page reload and animation-frame health signal support kiosk recovery.
2. **Scene:** create on the dashboard from starter layers; open `?editor=<id>`; change scene, layers and optionally device layout; save scene and screen layout with separate actions. Publish/Go live from the dashboard updates `wall_state`. The next player poll receives the published scene. The editor's duration field is persisted, but the current dashboard publishes manually; this file does not imply an implemented cycle scheduler.

See [rendering model](rendering-model.md) for coordinate details and [kiosk guide](raspberry-pi-kiosk.md) for OS-level recovery.

Live input uses the dedicated authenticated WSS service described in [live input design](live-input-design.md). In production, a Cloudflare named tunnel exposes that signaling service at a stable hostname; it carries signaling only, while WebRTC media travels directly between the editor and each Pi. Deployment and environment ownership are documented in [production signaling deployment](production-signaling.md).
