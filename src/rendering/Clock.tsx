import { useEffect, useRef, useState, type CSSProperties } from 'react'

export function Clock({ style, timezone, serverEpochOffsetMs }: { style: CSSProperties; timezone?: string; serverEpochOffsetMs: number }) {
  const [now, setNow] = useState(() => performance.now() + serverEpochOffsetMs)
  const offsetRef = useRef(serverEpochOffsetMs)
  useEffect(() => { offsetRef.current = serverEpochOffsetMs }, [serverEpochOffsetMs])
  useEffect(() => {
    let frame = 0
    let displayedSecond = -1
    const tick = () => {
      const synchronizedNow = performance.now() + offsetRef.current
      const currentSecond = Math.floor(synchronizedNow / 1000)
      if (currentSecond !== displayedSecond) {
        displayedSecond = currentSecond
        setNow(synchronizedNow)
      }
      frame = window.requestAnimationFrame(tick)
    }
    tick()
    return () => window.cancelAnimationFrame(frame)
  }, [])
  return <time className="clock-layer" style={style}>{new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: timezone }).format(new Date(now))}</time>
}
