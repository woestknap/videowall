export const SIGNALING_VERSION = 1 as const

export type SignalingRole = 'editor' | 'player'
export type SignalingEndReason = 'controller-stopped' | 'player-left' | 'expired' | 'replaced' | 'signaling-error'

export type LiveSessionLease = {
  sessionId: string
  liveSourceId: string
  targetDeviceId: string
  expiresAt: string
  signalingUrl: string
}

export type EditorAuthMessage = {
  version: 1
  type: 'auth'
  role: 'editor'
  accessToken: string
  wallId: string
  targetDeviceId: string
  liveSourceId: string
}

export type PlayerAuthMessage = {
  version: 1
  type: 'auth'
  role: 'player'
  deviceId: string
  deviceToken: string
  sessionId: string
}

export type AuthenticatedMessage = {
  version: 1
  type: 'authenticated'
  role: SignalingRole
  sessionId: string
  wallId: string
  targetDeviceId: string
  liveSourceId: string
  generation: number
  expiresAt: string
}

type ScopedMessage<T extends string, P> = {
  version: 1
  type: T
  sessionId: string
  liveSourceId: string
  targetDeviceId: string
  generation: number
  payload: P
}

export type PeerReadyMessage = ScopedMessage<'peer-ready', Record<string, never>>
export type OfferMessage = ScopedMessage<'offer', { sdp: string }>
export type AnswerMessage = ScopedMessage<'answer', { sdp: string }>
export type IceCandidateMessage = ScopedMessage<'ice-candidate', { candidate: string | null; sdpMid: string | null; sdpMLineIndex: number | null }>
export type SessionEndedMessage = ScopedMessage<'session-ended', { reason: SignalingEndReason }>
export type SignalingErrorMessage = { version: 1; type: 'error'; code: string; message: string }

export type ClientSignalingMessage = EditorAuthMessage | PlayerAuthMessage | PeerReadyMessage | OfferMessage | AnswerMessage | IceCandidateMessage | SessionEndedMessage
export type ServerSignalingMessage = AuthenticatedMessage | PeerReadyMessage | OfferMessage | AnswerMessage | IceCandidateMessage | SessionEndedMessage | SignalingErrorMessage

export function parseServerSignalingMessage(value: string): ServerSignalingMessage | null {
  try {
    const message: unknown = JSON.parse(value)
    if (!message || typeof message !== 'object' || !('version' in message) || message.version !== SIGNALING_VERSION || !('type' in message) || typeof message.type !== 'string') return null
    if (message.type === 'error') return 'code' in message && typeof message.code === 'string' && 'message' in message && typeof message.message === 'string' ? message as SignalingErrorMessage : null
    if (message.type === 'authenticated') return 'sessionId' in message && typeof message.sessionId === 'string' && 'role' in message && (message.role === 'editor' || message.role === 'player') ? message as AuthenticatedMessage : null
    if (['peer-ready', 'offer', 'answer', 'ice-candidate', 'session-ended'].includes(message.type)) return 'sessionId' in message && typeof message.sessionId === 'string' && 'payload' in message ? message as ServerSignalingMessage : null
    return null
  } catch {
    return null
  }
}

export function scopedClientMessage<T extends PeerReadyMessage['type'] | SessionEndedMessage['type']>(scope: AuthenticatedMessage, type: T, payload: T extends 'peer-ready' ? Record<string, never> : { reason: SignalingEndReason }): PeerReadyMessage | SessionEndedMessage {
  return { version: SIGNALING_VERSION, type, sessionId: scope.sessionId, liveSourceId: scope.liveSourceId, targetDeviceId: scope.targetDeviceId, generation: scope.generation, payload } as PeerReadyMessage | SessionEndedMessage
}
