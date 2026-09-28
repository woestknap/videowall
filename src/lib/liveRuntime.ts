export type LiveSessionIdentity = { liveSourceId: string; deviceId: string }

// JSON encoding keeps a compact React/object key without delimiter collisions.
export function liveSessionKey({ liveSourceId, deviceId }: LiveSessionIdentity) {
  return JSON.stringify([liveSourceId, deviceId])
}

export function sameLiveSession(left: LiveSessionIdentity, right: LiveSessionIdentity) {
  return left.liveSourceId === right.liveSourceId && left.deviceId === right.deviceId
}

export class LiveSessionRegistry<T> {
  private readonly sources = new Map<string, Map<string, T>>()

  get(identity: LiveSessionIdentity) { return this.sources.get(identity.liveSourceId)?.get(identity.deviceId) }
  set(identity: LiveSessionIdentity, value: T) {
    const targets = this.sources.get(identity.liveSourceId) ?? new Map<string, T>()
    targets.set(identity.deviceId, value)
    this.sources.set(identity.liveSourceId, targets)
  }
  delete(identity: LiveSessionIdentity) {
    const targets = this.sources.get(identity.liveSourceId)
    if (!targets) return false
    const removed = targets.delete(identity.deviceId)
    if (!targets.size) this.sources.delete(identity.liveSourceId)
    return removed
  }
  entries() {
    return [...this.sources.entries()].flatMap(([liveSourceId, targets]) => [...targets.entries()].map(([deviceId, value]) => ({ identity: { liveSourceId, deviceId }, value })))
  }
  entriesForSource(liveSourceId: string) {
    return [...(this.sources.get(liveSourceId) ?? new Map<string, T>()).entries()].map(([deviceId, value]) => ({ identity: { liveSourceId, deviceId }, value }))
  }
  clearSource(liveSourceId: string) { const entries = this.entriesForSource(liveSourceId); this.sources.delete(liveSourceId); return entries }
  get size() { return [...this.sources.values()].reduce((count, targets) => count + targets.size, 0) }
}

export function replaceLiveStream(streams: ReadonlyMap<string, MediaStream>, liveSourceId: string, stream: MediaStream) {
  return new Map(streams).set(liveSourceId, stream)
}

export function removeLiveStream(streams: ReadonlyMap<string, MediaStream>, liveSourceId: string) {
  const next = new Map(streams)
  next.delete(liveSourceId)
  return next
}
