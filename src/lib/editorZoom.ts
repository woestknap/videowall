export type Point = { x: number; y: number }
export type Pan = Point
export type EditorView = { zoom: number; pan: Pan }
export type StageGeometry = { center: Point; width: number; height: number }
export type WorkspaceRect = { x: number; y: number; width: number; height: number }
export type ClientRect = { left: number; top: number; width: number; height: number }

export const MIN_EDITOR_ZOOM = .2
export const MAX_EDITOR_ZOOM = 128

// CSS scales the stage about its centre, then translates it in client pixels.
// Undo that transform once: getBoundingClientRect() alone is already transformed.
export function stageGeometryFromRect(rect: { left: number; top: number; width: number; height: number }, view: EditorView): StageGeometry {
  return {
    center: { x: rect.left + rect.width / 2 - view.pan.x, y: rect.top + rect.height / 2 - view.pan.y },
    width: rect.width / view.zoom,
    height: rect.height / view.zoom,
  }
}

export function workspacePointToClient(point: Point, view: EditorView, stage: StageGeometry, wall: { width: number; height: number }): Point {
  return {
    x: stage.center.x + view.pan.x + (point.x / wall.width - .5) * stage.width * view.zoom,
    y: stage.center.y + view.pan.y + (point.y / wall.height - .5) * stage.height * view.zoom,
  }
}

export function workspaceRectToClientRect(rect: WorkspaceRect, view: EditorView, stage: StageGeometry, wall: { width: number; height: number }): ClientRect {
  const topLeft = workspacePointToClient({ x: rect.x, y: rect.y }, view, stage, wall)
  return {
    left: topLeft.x,
    top: topLeft.y,
    width: rect.width / wall.width * stage.width * view.zoom,
    height: rect.height / wall.height * stage.height * view.zoom,
  }
}

export function clientPointToWorkspace(point: Point, view: EditorView, stage: StageGeometry, wall: { width: number; height: number }): Point {
  return {
    x: (.5 + (point.x - stage.center.x - view.pan.x) / (stage.width * view.zoom)) * wall.width,
    y: (.5 + (point.y - stage.center.y - view.pan.y) / (stage.height * view.zoom)) * wall.height,
  }
}

export function deltaClientToWorkspace(delta: Point, zoom: number, stage: Pick<StageGeometry, 'width' | 'height'>, wall: { width: number; height: number }): Point {
  return { x: delta.x / (stage.width * zoom) * wall.width, y: delta.y / (stage.height * zoom) * wall.height }
}

export type WorkspaceDrag = {
  startClient: Point
  startPosition: Point
  zoom: number
  stage: Pick<StageGeometry, 'width' | 'height'>
  wall: { width: number; height: number }
  lastClient: Point
  segmentClient: Point
  segmentDelta: Point
  fine: boolean
}

export function startWorkspaceDrag(startClient: Point, startPosition: Point, zoom: number, stage: Pick<StageGeometry, 'width' | 'height'>, wall: { width: number; height: number }): WorkspaceDrag {
  return { startClient, startPosition, zoom, stage: { width: stage.width, height: stage.height }, wall: { ...wall }, lastClient: startClient, segmentClient: startClient, segmentDelta: { x: 0, y: 0 }, fine: false }
}

// Each position comes from the original layout plus an absolute pointer delta.
// Modifier changes start a new sensitivity segment at the previous pointer
// position, so pressing or releasing Shift does not move the box by itself.
export function advanceWorkspaceDrag(drag: WorkspaceDrag, client: Point, fine: boolean): { drag: WorkspaceDrag; position: Point } {
  const previousScale = drag.fine ? .1 : 1
  const previousDelta = {
    x: drag.segmentDelta.x + (drag.lastClient.x - drag.segmentClient.x) * previousScale,
    y: drag.segmentDelta.y + (drag.lastClient.y - drag.segmentClient.y) * previousScale,
  }
  const segmentClient = fine === drag.fine ? drag.segmentClient : drag.lastClient
  const segmentDelta = fine === drag.fine ? drag.segmentDelta : previousDelta
  const scale = fine ? .1 : 1
  const effective = {
    x: segmentDelta.x + (client.x - segmentClient.x) * scale,
    y: segmentDelta.y + (client.y - segmentClient.y) * scale,
  }
  const workspace = deltaClientToWorkspace(effective, drag.zoom, drag.stage, drag.wall)
  return {
    drag: { ...drag, lastClient: client, segmentClient, segmentDelta, fine },
    position: { x: drag.startPosition.x + workspace.x, y: drag.startPosition.y + workspace.y },
  }
}

export function zoomAroundCursor(view: EditorView, nextZoom: number, stage: StageGeometry, cursor: Point, wall: { width: number; height: number }): EditorView {
  if (!Number.isFinite(nextZoom) || !Number.isFinite(view.zoom) || view.zoom <= 0 || stage.width <= 0 || stage.height <= 0) return view
  const zoom = Math.max(MIN_EDITOR_ZOOM, Math.min(MAX_EDITOR_ZOOM, nextZoom))
  const world = clientPointToWorkspace(cursor, view, stage, wall)
  const unpannedClient = workspacePointToClient(world, { zoom, pan: { x: 0, y: 0 } }, stage, wall)
  return { zoom, pan: { x: cursor.x - unpannedClient.x, y: cursor.y - unpannedClient.y } }
}

export function zoomFromWheel(zoom: number, deltaY: number, deltaMode = 0, pageHeight = 800): number {
  const pixels = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? pageHeight : 1)
  const bounded = Math.max(-100, Math.min(100, pixels))
  return Math.max(MIN_EDITOR_ZOOM, Math.min(MAX_EDITOR_ZOOM, zoom * Math.exp(-bounded * Math.log(1.07) / 100)))
}

export function displayedZoomPercent(zoom: number, fitZoom: number): number {
  if (!Number.isFinite(zoom) || !Number.isFinite(fitZoom) || fitZoom <= 0) return 100
  return zoom / fitZoom * 100
}

export type DeviceNudgeKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'

export function nudgeDevicePosition(position: Point, key: DeviceNudgeKey, fine: boolean): Point {
  const distance = fine ? .1 : 1
  return {
    x: position.x + (key === 'ArrowLeft' ? -distance : key === 'ArrowRight' ? distance : 0),
    y: position.y + (key === 'ArrowUp' ? -distance : key === 'ArrowDown' ? distance : 0),
  }
}

export function devicePositionChange(position: Point) {
  return { layout_x: position.x, layout_y: position.y }
}

type FitEditorViewInput = {
  bounds: { x: number; y: number; width: number; height: number }
  workspace: { width: number; height: number }
  stage: { width: number; height: number }
  wall: { width: number; height: number }
  padding?: number
}

export function fitEditorView({ bounds, workspace, stage, wall, padding = .84 }: FitEditorViewInput): EditorView | null {
  if (![bounds.width, bounds.height, workspace.width, workspace.height, stage.width, stage.height, wall.width, wall.height].every(value => Number.isFinite(value) && value > 0)) return null
  const wallWidth = bounds.width / wall.width * stage.width
  const wallHeight = bounds.height / wall.height * stage.height
  const zoom = Math.max(MIN_EDITOR_ZOOM, Math.min(MAX_EDITOR_ZOOM, padding * Math.min(workspace.width / wallWidth, workspace.height / wallHeight)))
  return {
    zoom,
    pan: {
      x: (.5 - (bounds.x + bounds.width / 2) / wall.width) * stage.width * zoom,
      y: (.5 - (bounds.y + bounds.height / 2) / wall.height) * stage.height * zoom,
    },
  }
}
