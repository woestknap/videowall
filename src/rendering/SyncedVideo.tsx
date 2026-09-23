import { useEffect, useRef, type CSSProperties } from 'react'

export function SyncedVideo({ style, src, muted, loop, serverEpochOffsetMs, sceneStartedAtMs }: { style: CSSProperties; src: string; muted: boolean; loop: boolean; serverEpochOffsetMs: number; sceneStartedAtMs: number }) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  useEffect(() => {
    const video = videoRef.current; if (!video || !sceneStartedAtMs) return
    const expectedPosition = () => {
      const elapsedSeconds = Math.max(0, (performance.now() + serverEpochOffsetMs - sceneStartedAtMs) / 1000)
      if (!video.duration || !Number.isFinite(video.duration)) return 0
      return loop ? elapsedSeconds % video.duration : Math.min(elapsedSeconds, video.duration)
    }
    const align = () => {
      if (!video.duration || !Number.isFinite(video.duration)) return
      video.currentTime = expectedPosition()
      video.playbackRate = 1
      void video.play().catch(() => undefined)
    }
    const correctDrift = () => {
      if (!video.duration || !Number.isFinite(video.duration) || video.paused) return
      const expected = expectedPosition()
      let drift = expected - video.currentTime
      if (loop && Math.abs(drift) > video.duration / 2) drift -= Math.sign(drift) * video.duration
      if (Math.abs(drift) > .18) {
        video.currentTime = expected
        video.playbackRate = 1
      } else {
        video.playbackRate = Math.max(.97, Math.min(1.03, 1 + drift * .15))
      }
    }
    video.addEventListener('loadedmetadata', align)
    align()
    const timer = window.setInterval(correctDrift, 1500)
    return () => { video.removeEventListener('loadedmetadata', align); window.clearInterval(timer) }
  }, [src, loop, serverEpochOffsetMs, sceneStartedAtMs])
  return <video className="media-layer" ref={videoRef} style={style} src={src} autoPlay muted={muted} loop={loop} playsInline />
}
