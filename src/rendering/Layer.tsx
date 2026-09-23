import type { CSSProperties } from 'react'
import type { SceneLayer } from '../types'
import { Clock } from './Clock'
import { SyncedVideo } from './SyncedVideo'

export function Layer({ layer, serverEpochOffsetMs = Date.now() - performance.now(), sceneStartedAtMs = 0, rawVideo = false }: { layer: SceneLayer; serverEpochOffsetMs?: number; sceneStartedAtMs?: number; rawVideo?: boolean }) {
  const style: CSSProperties = { objectFit: layer.content.fit ?? 'cover', left: `${layer.x}%`, top: `${layer.y}%`, width: `${layer.width}%`, height: `${layer.height}%`, zIndex: layer.zIndex, opacity: layer.opacity ?? 1, transform: `rotate(${layer.rotation ?? 0}deg) scale(${layer.scale ?? 1})` }
  const typography = { fontFamily: layer.content.fontFamily ?? "'Roboto', sans-serif", fontSize: layer.content.fontSize ? `${layer.content.fontSize / 19.2}cqw` : undefined }
  if (layer.type === 'video' && layer.content.url) return rawVideo ? <video className="media-layer" style={style} src={layer.content.url} autoPlay muted={layer.content.muted !== false} loop={layer.content.loop !== false} playsInline /> : <SyncedVideo style={style} src={layer.content.url} muted={layer.content.muted !== false} loop={layer.content.loop !== false} serverEpochOffsetMs={serverEpochOffsetMs} sceneStartedAtMs={sceneStartedAtMs} />
  if (layer.type === 'image' && layer.content.url) return <img className="media-layer" style={style} src={layer.content.url} alt="" />
  if (layer.type === 'clock') return <Clock style={style} timezone={layer.content.timezone} serverEpochOffsetMs={serverEpochOffsetMs} />
  if (layer.type === 'ticker') return <div className="ticker-layer" style={{ ...style, ...typography }}><span>{layer.content.text}</span></div>
  return <div className="text-layer" style={{ ...style, ...typography }}>{layer.content.text}</div>
}
