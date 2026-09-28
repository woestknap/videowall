import { useEffect, useRef, type CSSProperties } from 'react'
import type { SceneLayer } from '../types'
import { Clock } from './Clock'
import { SyncedVideo } from './SyncedVideo'
import { layerPlaybackUrl } from '../media/mediaLibraryUtils'

function LiveVideo({ stream, style }: { stream: MediaStream; style: CSSProperties }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.srcObject = stream
    void video.play().catch(() => undefined)
    return () => { if (video.srcObject === stream) video.srcObject = null }
  }, [stream])
  return <video ref={videoRef} className="media-layer" style={style} autoPlay playsInline muted />
}

export type LayerGeometryMode = 'percentage' | 'virtual-pixel'

export function Layer({ layer, geometryMode = 'percentage', serverEpochOffsetMs = Date.now() - performance.now(), sceneStartedAtMs = 0, rawVideo = false, liveStream, onMediaStateChange }: { layer: SceneLayer; geometryMode?: LayerGeometryMode; serverEpochOffsetMs?: number; sceneStartedAtMs?: number; rawVideo?: boolean; liveStream?: MediaStream; onMediaStateChange?: (layerId: string, state: string) => void }) {
  const unit = geometryMode === 'virtual-pixel' ? 'px' : '%'
  const style: CSSProperties = { objectFit: layer.content.fit ?? 'cover', left: `${layer.x}${unit}`, top: `${layer.y}${unit}`, width: `${layer.width}${unit}`, height: `${layer.height}${unit}`, zIndex: layer.zIndex, opacity: layer.opacity ?? 1, transform: `rotate(${layer.rotation ?? 0}deg) scale(${layer.scale ?? 1})` }
  if (layer.type === 'live') return liveStream ? <LiveVideo stream={liveStream} style={style} /> : null
  const typography = { fontFamily: layer.content.fontFamily ?? "'Roboto', sans-serif", fontSize: layer.content.fontSize ? `${layer.content.fontSize / 19.2}cqw` : undefined }
  const mediaUrl = layerPlaybackUrl(layer)
  if (layer.type === 'video' && mediaUrl) return rawVideo ? <video className="media-layer" style={style} src={mediaUrl} autoPlay muted={layer.content.muted !== false} loop={layer.content.loop !== false} playsInline onLoadedData={() => onMediaStateChange?.(layer.id, 'LOADED')} onPlaying={() => onMediaStateChange?.(layer.id, 'PLAYING')} onPause={() => onMediaStateChange?.(layer.id, 'PAUSED')} onError={() => onMediaStateChange?.(layer.id, 'ERROR')} /> : <SyncedVideo style={style} src={mediaUrl} muted={layer.content.muted !== false} loop={layer.content.loop !== false} serverEpochOffsetMs={serverEpochOffsetMs} sceneStartedAtMs={sceneStartedAtMs} onMediaStateChange={state => onMediaStateChange?.(layer.id, state)} />
  if (layer.type === 'image' && mediaUrl) return <img className="media-layer" style={style} src={mediaUrl} alt="" onError={() => onMediaStateChange?.(layer.id, 'ERROR')} />
  if (layer.type === 'clock') return <Clock style={style} timezone={layer.content.timezone} serverEpochOffsetMs={serverEpochOffsetMs} />
  if (layer.type === 'ticker') return <div className="ticker-layer" style={{ ...style, ...typography }}><span>{layer.content.text}</span></div>
  return <div className="text-layer" style={{ ...style, ...typography }}>{layer.content.text}</div>
}
