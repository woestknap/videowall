import { useEffect, useRef, useState } from 'react'
import { WORKSPACE, bounds, deviceRect, layerReference, planeTransform, sceneDevices } from '../lib/wallGeometry'
import type { Device, Scene } from '../types'
import { Layer } from './Layer'

export type ScenePreviewProps = { scene: Scene; player?: boolean; deviceId?: string; devices?: Device[]; serverEpochOffsetMs?: number; sceneStartedAtMs?: number; videosDisabled?: boolean; rawVideos?: boolean; embedded?: boolean; liveStreams?: ReadonlyMap<string, MediaStream> }

export function ScenePreview({ scene, player = false, deviceId, devices = [], serverEpochOffsetMs = Date.now() - performance.now(), sceneStartedAtMs = 0, videosDisabled = false, rawVideos = false, embedded = false, liveStreams }: ScenePreviewProps) {
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
  return <div ref={root} className={player ? 'player-canvas' : 'scene-preview'} style={player ? { position: embedded ? 'relative' : 'fixed', inset: 0, width: embedded ? '100%' : '100vw', height: embedded ? '100%' : '100vh', overflow: 'hidden', background: '#000' } : { aspectRatio: `${view.width} / ${view.height}` }}>
    {!player && activeDevices.length ? activeDevices.map(device => {
      const box = deviceRect(device)
      return <div key={device.id} style={{ position: 'absolute', left: `${(box.x - view.x) / view.width * 100}%`, top: `${(box.y - view.y) / view.height * 100}%`, width: `${box.width / view.width * 100}%`, height: `${box.height / view.height * 100}%` }}>
        <ScenePreview scene={scene} devices={devices} deviceId={device.id} player embedded serverEpochOffsetMs={serverEpochOffsetMs} sceneStartedAtMs={sceneStartedAtMs} videosDisabled={videosDisabled} rawVideos={rawVideos} liveStreams={liveStreams} />
      </div>
    }) : viewport.width > 0 && layers.map(layer => {
      const reference = layerReference(layer, scene, devices, player ? current : undefined)
      return <div className="layer-plane" key={layer.id} style={{ position: 'absolute', left: 0, top: 0, width: reference.width, height: reference.height, zIndex: layer.zIndex, transformOrigin: '0 0', transform: planeTransform(reference, player && !current ? reference : view, viewport.width, viewport.height) }}>
        <Layer layer={layer} serverEpochOffsetMs={serverEpochOffsetMs} sceneStartedAtMs={sceneStartedAtMs} rawVideo={rawVideos} liveStream={layer.content.liveSourceId ? liveStreams?.get(layer.content.liveSourceId) : undefined} />
      </div>
    })}
  </div>
}
