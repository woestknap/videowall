import { useEffect, useRef, type CSSProperties } from 'react'
import { VIDEO_SYNC_INTERVAL_MS, videoSyncDecision, wrappedVideoDrift, type VideoSyncDiagnostics } from '../lib/videoSync'

export function SyncedVideo({ style, src, muted, loop, serverEpochOffsetMs, sceneStartedAtMs, onMediaStateChange, onSyncDiagnostic }: { style: CSSProperties; src: string; muted: boolean; loop: boolean; serverEpochOffsetMs: number; sceneStartedAtMs: number; onMediaStateChange?: (state: string) => void; onSyncDiagnostic?: (diagnostic: VideoSyncDiagnostics) => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const syncDiagnosticRef = useRef(onSyncDiagnostic)
  syncDiagnosticRef.current = onSyncDiagnostic
  useEffect(() => {
    const video = videoRef.current; if (!video || !sceneStartedAtMs) return
    let lastHardSeekAtMs: number | null = null
    let hardSeekCount = 0
    const expectedPosition = () => {
      const elapsedSeconds = Math.max(0, (performance.now() + serverEpochOffsetMs - sceneStartedAtMs) / 1000)
      if (!video.duration || !Number.isFinite(video.duration)) return 0
      return loop ? elapsedSeconds % video.duration : Math.min(elapsedSeconds, video.duration)
    }
    const align = () => {
      if (!video.duration || !Number.isFinite(video.duration)) return
      video.currentTime = expectedPosition()
      video.playbackRate = 1
      lastHardSeekAtMs = performance.now()
      syncDiagnosticRef.current?.({ driftMs: 0, playbackRate: 1, hardSeekCount })
      void video.play().catch(() => undefined)
    }
    const correctDrift = () => {
      if (!video.duration || !Number.isFinite(video.duration) || video.paused) return
      const expected = expectedPosition()
      const drift = wrappedVideoDrift(expected, video.currentTime, video.duration, loop)
      const now = performance.now()
      const decision = videoSyncDecision(drift, now, lastHardSeekAtMs)
      if (decision.hardSeek) {
        video.currentTime = expected
        lastHardSeekAtMs = now
        hardSeekCount += 1
      }
      video.playbackRate = decision.playbackRate
      syncDiagnosticRef.current?.({ driftMs: drift * 1000, playbackRate: decision.playbackRate, hardSeekCount, lastHardSeekAtMs: lastHardSeekAtMs ?? undefined })
    }
    video.addEventListener('loadedmetadata', align)
    align()
    const timer = window.setInterval(correctDrift, VIDEO_SYNC_INTERVAL_MS)
    return () => { video.removeEventListener('loadedmetadata', align); window.clearInterval(timer) }
  }, [src, loop, serverEpochOffsetMs, sceneStartedAtMs])
  return <video className="media-layer" ref={videoRef} style={style} src={src} autoPlay muted={muted} loop={loop} playsInline onLoadedData={() => onMediaStateChange?.('LOADED')} onPlaying={() => onMediaStateChange?.('PLAYING')} onPause={() => onMediaStateChange?.('PAUSED')} onError={() => onMediaStateChange?.('ERROR')} />
}
