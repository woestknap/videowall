export type LayerType = 'clock' | 'video' | 'image' | 'text' | 'ticker' | 'live'

export type LiveSourceKind = 'camera'

export type LiveSource = {
  id: string
  name: string
  kind: LiveSourceKind
  deviceId?: string
}

export type MediaAsset = {
  id: string
  name: string
  original_filename: string
  object_key: string
  public_url: string
  mime_type: string
  media_type: 'image' | 'video'
  size_bytes: number
  width: number | null
  height: number | null
  duration_seconds: number | null
  thumbnail_object_key: string | null
  thumbnail_url: string | null
  created_at: string
  created_by: string
}

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
  coordinateSpace?: 'legacy' | 'freeform' | 'virtual-pixel'
  sourceWidth?: number
  sourceHeight?: number
  content: {
    mediaAssetId?: string
    url?: string
    liveSourceId?: string
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
  wall_id?: string | null
  geometry_version?: 1 | 2
  canvas_width_px?: number | null
  canvas_height_px?: number | null
  wall_geometry_revision?: string | null
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
  auto_size?: boolean
  included_in_wall?: boolean
}

export type Wall = {
  id: string
  name: string
  layout_mode?: 'resolution' | 'physical' | null
  virtual_pixels_per_mm?: number | null
}
