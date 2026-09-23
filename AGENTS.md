# Videowall: Codex working guide

## Project

Personal browser-based videowall controller: React, TypeScript and Vite in the frontend; Supabase for persistent data, auth, media storage and RPCs. Raspberry Pi Chromium kiosk players each show one portion of a shared logical wall. Start with [architecture](docs/architecture.md); use [rendering model](docs/rendering-model.md) for coordinates/player rendering and [editor design](docs/editor-design.md) for editor work. [Live input design](docs/live-input-design.md) and [roadmap](docs/roadmap.md) describe plans, not current features.

## Preserve unless the task explicitly changes it

- Supabase remains the persistent backend; Pi players remain browser/kiosk based.
- Pairing, the browser-stored device token and the player RPC authorization path are coupled. Do not change them casually.
- Screens share wall coordinates; a layer can span displays, and each player crops its portion. Preserve scene `device_ids` and layer `target` filtering.
- Preserve synchronized video, server-clock calibration, polling, heartbeat and refresh behavior unless the task targets them. Pi 3 and Pi 4 decoding, memory and CPU limits matter.
- Preserve `?player=1`, `?editor=<scene-id>` and player diagnostics `debug=1`, `safe=1`, `noVideo=1`, `rawVideo=1`.
- Treat `tests/wallGeometry.test.mjs` and `/tests/rendering.html` as geometry/rendering regression constraints. The browser fixture does not prove video decoding or synchronization on a Pi.

## Workflow

1. Read this file, then only the documentation and source files relevant to the task.
2. Make small scoped changes. Preserve working behavior unless explicitly asked to change it; avoid broad repository refactors.
3. Run relevant checks, then stop when the requested phase is complete.

Avoid new state-management or routing libraries, speculative dependencies, casual Supabase schema or player timing changes, geometry rewrites during UI work, unrelated screen redesigns, and combining roadmap phases.

## Checks

```sh
npm run check
npm run test:geometry
npm run build
```

As [README.md](README.md) states, geometry tests require Node.js 22.18+ or 24. For the manual browser rendering regression, run `npm run dev` and open `/tests/rendering.html`; see README for its scope.
