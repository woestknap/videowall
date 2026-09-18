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
