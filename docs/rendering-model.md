# Current rendering model

`src/lib/wallGeometry.ts` defines the coordinate rules; `src/rendering/ScenePreview.tsx` projects them into browser viewports. Geometry changes can break cross-display alignment and legacy scenes, so do not casually rewrite this module. See `tests/wallGeometry.test.mjs`, `/tests/rendering.html` and [display calibration](display-calibration.md).

## Versioned geometry contract

Geometry version 1 remains the active editor and renderer described below. PIXEL-01 does not change its percentages, fixed workspace, player crop, or saved layer JSON.

Geometry version 2 is a persisted contract for later renderer/editor work. A V2 scene references a wall and stores its authoritative virtual canvas width and height in pixels plus the wall-geometry revision used to create it. `src/lib/virtualWallGeometry.ts` derives a normalized virtual plane in two explicit modes:

- Resolution mode maps pixel-layout rectangles directly into virtual pixels.
- Physical mode multiplies every measured millimetre rectangle by one wall-wide `virtualPixelsPerMm`. A physically larger display therefore keeps a proportionally larger virtual region regardless of its Chromium viewport resolution.

Runtime viewport pixels remain separate from device virtual regions. Negative positions and gaps are retained while the resulting virtual wall is normalized to origin. Physical and resolution inputs cannot be silently mixed. The geometry revision fingerprints layout mode, physical calibration and device layout rectangles, while excluding viewport resolution and unrelated metadata.

`ScenePreview` selects an explicit renderer from `geometry_version`: missing/1 uses the unchanged V1 percentage path, while 2 requires a valid persisted canvas, matching geometry revision and PIXEL-01 virtual-wall result. PIXEL-03A gives the dashboard an explicit V2 creation action and the editor a separate virtual-pixel path; legacy creation and V1 editing remain available without conversion.

## V2 shared virtual-pixel plane

A V2 wall layer must use `space: 'wall'` and `coordinateSpace: 'virtual-pixel'`; its `x`, `y`, `width` and `height` are absolute positions on the persisted pixel canvas. The renderer creates one canvas-sized plane. For a device region `(rx, ry, rw, rh)` and measured browser viewport `(vw, vh)`, it applies `scaleX = vw / rw`, `scaleY = vh / rh`, and translation `(-rx * scaleX, -ry * scaleY)`. The player clips that transformed shared plane to its viewport.

This mapping deliberately permits different horizontal and vertical output scales. A runtime viewport controls output raster density only: it never changes a device's virtual footprint. Physical mode therefore preserves calibrated size ratios even when displays report equal resolutions, and equal physical footprints stay equal when resolutions differ. Normalized region coordinates are consumed directly, with no second origin adjustment. Empty areas between regions remain true bezel/gap space and appear on no player; a layer crossing device boundaries remains continuous because every device crops the same virtual coordinates.

V2 does not reinterpret unsupported screen-local or legacy-coordinate layers. Missing canvas data, malformed/invalid virtual geometry, a stale geometry revision, a canvas/wall size mismatch, a missing current-device region, or an unsupported layer geometry produces a concise safe diagnostic instead of falling back to percentages. Media object-fit, transforms, opacity, z-order, synchronized video and live-stream selection remain shared by both paths. Existing container-relative text sizing is retained intentionally; pixel-native typography editing belongs with later V2 editor work.

In the V2 editor, the persisted canvas is the logical workspace and zoom/pan are transient view state. Device outlines come directly from the current PIXEL-01 normalized regions, while layer positions and dimensions remain stored as virtual pixels. Fit canvas frames the entire persisted canvas rather than recomputing its size from current devices. A changed wall-geometry revision produces a warning but does not rewrite the canvas or layer geometry.

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

`SyncedVideo` computes expected playback position from elapsed server time, wrapping for loops or clamping otherwise. After metadata loads it aligns once; it then samples drift every 600 ms. Drift through 500 ms uses bounded playback-rate correction (0.97–1.03), drift through one second uses a stronger bounded correction (0.95–1.05), and a hard seek is reserved for drift beyond one second. Hard seeks have a five-second cooldown to avoid repeated decoder disruption on constrained players. `rawVideo=1` uses a plain video element instead. `Clock` uses the same server offset and updates on second boundaries. These are browser-level approximations, not hardware frame lock.
