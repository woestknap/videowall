export type LayerType = 'clock' | 'video' | 'image' | 'text'

export type SceneLayer = {
  id: string
  type: LayerType
  target: string[]
  x: number
  y: number
  width: number
  height: number
  zIndex: number
  opacity?: number
  content: {
    url?: string
    text?: string
    timezone?: string
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
}

export type Device = {
  id: string
  name: string
  wall_id: string
  last_seen_at: string | null
  width: number | null
  height: number | null
}

export type Wall = { id: string; name: string }
