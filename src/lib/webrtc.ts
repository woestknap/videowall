export type PendingIceCandidate = RTCIceCandidateInit | null

export function webRtcConfiguration(stunValue: string | undefined): RTCConfiguration {
  const urls = (stunValue ?? '').split(',').map(value => value.trim()).filter(Boolean)
  return { iceServers: urls.length ? [{ urls }] : [] }
}

export async function addOrQueueIceCandidate(peer: RTCPeerConnection | null, candidate: PendingIceCandidate, queue: PendingIceCandidate[]) {
  if (!peer || !peer.remoteDescription) {
    queue.push(candidate)
    return
  }
  await peer.addIceCandidate(candidate)
}

export async function flushIceCandidates(peer: RTCPeerConnection, queue: PendingIceCandidate[]) {
  if (!peer.remoteDescription) return
  for (const candidate of queue.splice(0)) await peer.addIceCandidate(candidate)
}
