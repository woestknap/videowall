# Scene editor: current behavior and planned UX

## Current behavior

`src/editor/SceneEditorPage.tsx` owns both the canvas and inspector state. It explicitly branches on `geometry_version`: V1 retains percentage geometry and `src/ScreenLayoutControls.tsx`, while V2 uses the scene's persisted virtual-pixel canvas and current PIXEL-01 device regions. Scene changes and V1 device-layout changes have separate save buttons.

- Left controls select participating screens (`scene.device_ids`), edit device names and rectangles, choose a selected layer's screen/wall canvas and target devices, and add image/video layers. Other layer types exist in `src/types.ts` and the renderer but are not currently added by this editor.
- The wall canvas shows media and screen masks. Pointer drag moves layers or screen labels; clicking a layer selects it. The editor starts at 100% zoom and zero pan. Wheel zoom keeps the cursor's wall point stable via `src/lib/editorZoom.ts`; Space-drag or middle mouse pans. Zoom, Fit screens and Reset controls sit above the canvas.
- The right inspector edits the selected media layer: image/video type and URL, selection or upload through the reusable R2 Media Library, aspect lock, fit to selected screens, cover/contain, rotation, scale, stacking (`zIndex`), position and size, and removal. Selecting an asset stores both its durable ID and direct playback URL. Legacy URL-only media remains editable.
- Device layout can use the reported player resolution or explicit measured dimensions. A warning appears when participating devices mix these units. See [display calibration](display-calibration.md).
- The dashboard exposes separate Legacy and Virtual-pixel scene actions. V2 creation requires valid geometry for the selected wall, persists the canvas dimensions/revision, and starts empty. V2 layers use `coordinateSpace: 'virtual-pixel'`; dragging, inspector dimensions, guides and Fit layer operate in that pixel plane. Fit canvas changes only view state. A current-wall revision mismatch is shown without changing saved geometry. Media layers still use deterministic placeholders; intrinsic media sizing is deferred to PIXEL-03B.

The canvas, its drag/zoom handlers, selection and inspector remain together in one component. [Rendering model](rendering-model.md) describes the coordinate rules these controls must preserve.

## Planned UX direction (not implemented)

- Keep the dark visual identity and compact control-software feel. Improve information hierarchy within that style.
- Fit the active wall more usefully when the editor opens. Make scene, source and layer hierarchy clearer in the left sidebar, including visible layer order.
- Keep the right sidebar as the property inspector and group related controls more clearly.
- Place zoom/fit controls in a clearer canvas toolbar/status area; reduce persistent instructional clutter.

UI work must preserve scene semantics, device targeting and media behavior. It must not rewrite wall rendering math. See [roadmap](roadmap.md) for scoped UI tasks.
