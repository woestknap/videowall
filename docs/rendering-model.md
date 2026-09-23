# Current rendering model

`src/lib/wallGeometry.ts` defines the coordinate rules; `src/rendering/ScenePreview.tsx` projects them into browser viewports. Geometry changes can break cross-display alignment and legacy scenes, so do not casually rewrite this module. See `tests/wallGeometry.test.mjs`, `/tests/rendering.html` and [display calibration](display-calibration.md).

## Rectangles and selection

- `WORKSPACE` is a fixed `{x: 0, y: 0, width: 7680, height: 4320}` reference plane. Layer `x`, `y`, `width` and `height` are percentages of their selected reference rectangle.
- Each device has `layout_x/y/width/height`. `deviceRect` falls back to reported viewport width/height and then 1920×1080; width and height are clamped to at least 1. Layout coordinates may be fractional or negative. For measured layouts, use one consistent physical unit (millimetres in the calibration guide) across every screen; player pixel resolution is applied only at projection.
- Empty/missing scene `device_ids` means all devices participate. Empty layer `target` means all eligible devices; a nonempty target list selects specific device IDs. The player suppresses layers when its device is excluded from the scene, and filters layers by `target` and diagnostic video settings.

## Layer reference and crop

- Missing `space` defaults to `screen`: with a current device, the layer's percentages are relative to that device rectangle, producing one copy per targeted screen. Without a current device, the helper uses `WORKSPACE`.
- `space: 'wall'` with `coordinateSpace: 'freeform'` (or an `aspectRatio`) uses `WORKSPACE`. Older wall layers use participating-device bounds including the origin. The editor's `toWorkspaceLayer` converts those older coordinates for editing and saving.
- `ScenePreview` chooses a *view*: the current device rectangle for a player, participating-device bounds for an admin preview, or `WORKSPACE` when no device bounds are available. `planeTransform` maps the layer reference into view pixels, and the player viewport clips overflow. The full wall layer is transformed before clipping; it is not shrunk to fit a single screen. Physical gaps simply show none of the layer.
- The dashboard preview lays out embedded per-device `ScenePreview` instances inside a bounding preview. An embedded preview has relative sizing; the actual player uses a fixed full-viewport canvas. Both use the same layer projection and crop. `ResizeObserver` updates viewport dimensions, including fractional sizes.

`Layer.tsx` applies `object-fit: cover` by default or `contain` as stored in layer content; this controls image/video content within its layer box. It applies rotation, scale, opacity and z-index to the layer, with wall projection and screen clipping outside it. The editor's Fit layer action computes participating target-device bounds and resets rotation/scale.

## Synchronized media and clock

The player takes seven `get_server_time` samples, keeps the fastest round trip, and recalibrates every five minutes. `serverEpochOffsetMs` translates `performance.now()` into estimated server epoch time. `wall_state.changed_at` arrives as `scene_started_at` and becomes `sceneStartedAtMs`.

`SyncedVideo` computes expected playback position from elapsed server time, wrapping for loops or clamping otherwise. After metadata loads it aligns playback; every 1.5 seconds it seeks if absolute drift exceeds 0.18 seconds, otherwise adjusts playback rate within 0.97–1.03. `rawVideo=1` uses a plain video element instead. `Clock` uses the same server offset and updates on second boundaries. These are browser-level approximations, not hardware frame lock.
