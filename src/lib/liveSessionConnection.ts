import type { LiveSessionLease } from '../signalingProtocol'

/** Fields that require a fresh player signaling/WebRTC connection when changed. */
export function liveSessionConnectionIdentity(device: { id: string; token: string }, lease: LiveSessionLease) {
  return JSON.stringify([device.id, device.token, lease.sessionId, lease.liveSourceId, lease.targetDeviceId, lease.signalingUrl])
}

export function liveSessionLeaseIsActive(expiresAt: string, now = Date.now()) {
  return new Date(expiresAt).getTime() > now
}
