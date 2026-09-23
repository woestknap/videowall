export type Pan = { x: number; y: number }

type CursorZoomInput = {
  pan: Pan
  zoom: number
  nextZoom: number
  stage: { left: number; top: number; width: number; height: number }
  cursor: { x: number; y: number }
}

// The editor stage scales from its centre. Offset pan by the complementary
// fraction of the scale change so the workspace coordinate under the cursor
// remains fixed while the user turns the wheel.
export function panForCursorZoom({ pan, zoom, nextZoom, stage, cursor }: CursorZoomInput): Pan {
  if (!Number.isFinite(zoom) || zoom <= 0 || !Number.isFinite(nextZoom) || stage.width <= 0 || stage.height <= 0) return pan
  const localX = (cursor.x - stage.left) / stage.width
  const localY = (cursor.y - stage.top) / stage.height
  const change = nextZoom - zoom
  return {
    x: pan.x + (.5 - localX) * (stage.width / zoom) * change,
    y: pan.y + (.5 - localY) * (stage.height / zoom) * change,
  }
}

type FitEditorViewInput = {
  bounds: { x: number; y: number; width: number; height: number }
  workspace: { width: number; height: number }
  stage: { width: number; height: number }
  wall: { width: number; height: number }
  padding?: number
}

export function fitEditorView({ bounds, workspace, stage, wall, padding = .84 }: FitEditorViewInput): { zoom: number; pan: Pan } | null {
  if (![bounds.width, bounds.height, workspace.width, workspace.height, stage.width, stage.height, wall.width, wall.height].every(value => Number.isFinite(value) && value > 0)) return null
  const wallWidth = bounds.width / wall.width * stage.width
  const wallHeight = bounds.height / wall.height * stage.height
  const zoom = Math.max(.2, Math.min(128, padding * Math.min(workspace.width / wallWidth, workspace.height / wallHeight)))
  return {
    zoom,
    pan: {
      x: (.5 - (bounds.x + bounds.width / 2) / wall.width) * stage.width * zoom,
      y: (.5 - (bounds.y + bounds.height / 2) / wall.height) * stage.height * zoom,
    },
  }
}
