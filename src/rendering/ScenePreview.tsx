import { useEffect, useRef, useState } from 'react'
import { WORKSPACE, bounds, deviceRect, layerReference, planeTransform, sceneDevices } from '../lib/wallGeometry'
import { sceneGeometryVersion, validateV2SceneRender, virtualPlaneTransform, type VirtualWallGeometryResult } from '../lib/virtualWallGeometry'
import type { Device, Scene } from '../types'
import { Layer } from './Layer'

export type ScenePreviewProps = { scene: Scene; player?: boolean; deviceId?: string; devices?: Device[]; virtualWallGeometry?: VirtualWallGeometryResult | null; serverEpochOffsetMs?: number; sceneStartedAtMs?: number; videosDisabled?: boolean; rawVideos?: boolean; embedded?: boolean; liveStreams?: ReadonlyMap<string, MediaStream>; onMediaStateChange?: (layerId: string, state: string) => void; onLivePresentationFps?: (liveSourceId: string, fps: number) => void }

export function ScenePreview(props: ScenePreviewProps) {
  return sceneGeometryVersion(props.scene) === 2 ? <V2ScenePreview {...props} /> : <V1ScenePreview {...props} />
}

// Keep the complete legacy render path isolated: V1 scene geometry continues to
// use the same percentages, reference planes, preview tiling, and crop transform.
function V1ScenePreview({ scene, player = false, deviceId, devices = [], serverEpochOffsetMs = Date.now() - performance.now(), sceneStartedAtMs = 0, videosDisabled = false, rawVideos = false, embedded = false, liveStreams, onMediaStateChange, onLivePresentationFps }: ScenePreviewProps) {
  const root = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const element = root.current
    if (!element) return
    const update = () => setViewport({ width: element.clientWidth, height: element.clientHeight })
    update()
    const observer = new ResizeObserver(([entry]) => {
      setViewport({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const current = devices.find(item => item.id === deviceId)
  const activeDevices = sceneDevices(scene, devices)
  const view = player && current ? deviceRect(current) : activeDevices.length ? bounds(activeDevices.map(deviceRect)) : WORKSPACE
  const excluded = player && deviceId && scene.device_ids?.length && !scene.device_ids.includes(deviceId)
  const layers = excluded ? [] : scene.layers.filter(layer => (!deviceId || !layer.target.length || layer.target.includes(deviceId)) && (!videosDisabled || (layer.type !== 'video' && layer.type !== 'live')))
  return <div ref={root} className={player ? 'player-canvas' : 'scene-preview screenmesh-workspace-grid'} style={player ? { position: embedded ? 'relative' : 'fixed', inset: 0, width: embedded ? '100%' : '100vw', height: embedded ? '100%' : '100vh', overflow: 'hidden', background: '#000' } : { aspectRatio: `${view.width} / ${view.height}` }}>
    {!player && activeDevices.length ? activeDevices.map(device => {
      const box = deviceRect(device)
      return <div key={device.id} style={{ position: 'absolute', left: `${(box.x - view.x) / view.width * 100}%`, top: `${(box.y - view.y) / view.height * 100}%`, width: `${box.width / view.width * 100}%`, height: `${box.height / view.height * 100}%` }}>
        <V1ScenePreview scene={scene} devices={devices} deviceId={device.id} player embedded serverEpochOffsetMs={serverEpochOffsetMs} sceneStartedAtMs={sceneStartedAtMs} videosDisabled={videosDisabled} rawVideos={rawVideos} liveStreams={liveStreams} onMediaStateChange={onMediaStateChange} onLivePresentationFps={onLivePresentationFps} />
      </div>
    }) : viewport.width > 0 && layers.map(layer => {
      const reference = layerReference(layer, scene, devices, player ? current : undefined)
      return <div className="layer-plane" key={layer.id} style={{ position: 'absolute', left: 0, top: 0, width: reference.width, height: reference.height, zIndex: layer.zIndex, transformOrigin: '0 0', transform: planeTransform(reference, player && !current ? reference : view, viewport.width, viewport.height) }}>
        <Layer layer={layer} serverEpochOffsetMs={serverEpochOffsetMs} sceneStartedAtMs={sceneStartedAtMs} rawVideo={rawVideos} liveStream={layer.content.liveSourceId ? liveStreams?.get(layer.content.liveSourceId) : undefined} onMediaStateChange={onMediaStateChange} onLivePresentationFps={onLivePresentationFps} />
      </div>
    })}
  </div>
}

function V2ScenePreview({ scene, player = false, deviceId, virtualWallGeometry, serverEpochOffsetMs = Date.now() - performance.now(), sceneStartedAtMs = 0, videosDisabled = false, rawVideos = false, embedded = false, liveStreams, onMediaStateChange, onLivePresentationFps }: ScenePreviewProps) {
  const root = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const element = root.current
    if (!element) return
    const update = () => setViewport({ width: element.clientWidth, height: element.clientHeight })
    update()
    const observer = new ResizeObserver(([entry]) => setViewport({ width: entry.contentRect.width, height: entry.contentRect.height }))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const contract = validateV2SceneRender(scene, virtualWallGeometry, player ? deviceId : undefined)
  if (contract.status === 'invalid') {
    return <div ref={root} className={player ? 'player-canvas v2-render-error' : 'scene-preview v2-render-error'} data-v2-render-error={contract.reason}>V2 geometry unavailable: {contract.reason}</div>
  }
  const regions = virtualWallGeometry?.status === 'valid'
    ? virtualWallGeometry.devices.filter(region => !scene.device_ids?.length || scene.device_ids.includes(region.deviceId))
    : []
  const excluded = player && deviceId && scene.device_ids?.length && !scene.device_ids.includes(deviceId)
  const layers = excluded ? [] : scene.layers.filter(layer => (!deviceId || !layer.target.length || layer.target.includes(deviceId)) && (!videosDisabled || (layer.type !== 'video' && layer.type !== 'live')))
  const view = contract.region ?? contract.canvas
  const transform = virtualPlaneTransform(view, viewport)
  const rootStyle = player
    ? { position: embedded ? 'relative' as const : 'fixed' as const, inset: 0, width: embedded ? '100%' : '100vw', height: embedded ? '100%' : '100vh', overflow: 'hidden', background: '#000' }
    : { aspectRatio: `${contract.canvas.width} / ${contract.canvas.height}` }

  return <div ref={root} className={player ? 'player-canvas' : 'scene-preview screenmesh-workspace-grid'} data-geometry-version="2" style={rootStyle}>
    {!player ? regions.map(region => <div key={region.deviceId} style={{ position: 'absolute', left: `${region.xPx / contract.canvas.width * 100}%`, top: `${region.yPx / contract.canvas.height * 100}%`, width: `${region.widthPx / contract.canvas.width * 100}%`, height: `${region.heightPx / contract.canvas.height * 100}%` }}>
      <V2ScenePreview scene={scene} deviceId={region.deviceId} player embedded virtualWallGeometry={virtualWallGeometry} serverEpochOffsetMs={serverEpochOffsetMs} sceneStartedAtMs={sceneStartedAtMs} videosDisabled={videosDisabled} rawVideos={rawVideos} liveStreams={liveStreams} onMediaStateChange={onMediaStateChange} onLivePresentationFps={onLivePresentationFps} />
    </div>) : transform && <div className="layer-plane" data-virtual-plane style={{ position: 'absolute', left: 0, top: 0, width: contract.canvas.width, height: contract.canvas.height, transformOrigin: '0 0', transform: transform.cssTransform }}>
      {layers.map(layer => <Layer key={layer.id} layer={layer} geometryMode="virtual-pixel" serverEpochOffsetMs={serverEpochOffsetMs} sceneStartedAtMs={sceneStartedAtMs} rawVideo={rawVideos} liveStream={layer.content.liveSourceId ? liveStreams?.get(layer.content.liveSourceId) : undefined} onMediaStateChange={onMediaStateChange} onLivePresentationFps={onLivePresentationFps} />)}
    </div>}
  </div>
}
