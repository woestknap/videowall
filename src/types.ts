export type LayerType = 'clock' | 'video' | 'image' | 'text' | 'ticker'

export type SceneLayer = {
  id: string
  type: LayerType
  target: string[]
  x: number
  y: number
  width: number
  height: number
  zIndex: number
  space?: 'screen' | 'wall'
  opacity?: number
  rotation?: number
  scale?: number
  lockedAspect?: boolean
  aspectRatio?: number
  content: {
    url?: string
    text?: string
    timezone?: string
    fontFamily?: string
    fontSize?: number
    fit?: 'cover' | 'contain'
    muted?: boolean
    loop?: boolean
  }
}

export type Scene = {
  id: string
  name: string
  layers: SceneLayer[]
  duration_seconds: number
  // Empty means every display on the wall participates in this scene.
  device_ids?: string[]
}

export type Device = {
  id: string
  name: string
  wall_id: string
  last_seen_at: string | null
  width: number | null
  height: number | null
  layout_x?: number
  layout_y?: number
  layout_width?: number
  layout_height?: number
}

export type Wall = { id: string; name: string }
