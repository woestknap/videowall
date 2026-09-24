export const SIGNALING_VERSION = 1
export const MAX_SIGNALING_MESSAGE_BYTES = 64 * 1024

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SESSION_ID = /^[A-Za-z0-9_-]{32,128}$/
const END_REASONS = new Set(['controller-stopped', 'player-left', 'expired', 'replaced', 'signaling-error'])

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(value, keys) {
  return Object.keys(value).every((key) => keys.includes(key))
}

function isUuid(value) {
  return typeof value === 'string' && UUID.test(value)
}

function isScope(message) {
  return SESSION_ID.test(message.sessionId ?? '') &&
    isUuid(message.liveSourceId) &&
    isUuid(message.targetDeviceId) &&
    Number.isInteger(message.generation) && message.generation > 0
}

function validatePayload(type, payload) {
  if (!isRecord(payload)) return false
  if (type === 'peer-ready') return hasOnlyKeys(payload, [])
  if (type === 'offer' || type === 'answer') {
    return hasOnlyKeys(payload, ['sdp']) && typeof payload.sdp === 'string' && payload.sdp.length > 0 && payload.sdp.length <= 50_000
  }
  if (type === 'ice-candidate') {
    return hasOnlyKeys(payload, ['candidate', 'sdpMid', 'sdpMLineIndex']) &&
      (payload.candidate === null || (typeof payload.candidate === 'string' && payload.candidate.length <= 4096)) &&
      (payload.sdpMid === null || (typeof payload.sdpMid === 'string' && payload.sdpMid.length <= 256)) &&
      (payload.sdpMLineIndex === null || (Number.isInteger(payload.sdpMLineIndex) && payload.sdpMLineIndex >= 0))
  }
  if (type === 'session-ended') {
    return hasOnlyKeys(payload, ['reason']) && END_REASONS.has(payload.reason)
  }
  return false
}

export function parseClientMessage(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_SIGNALING_MESSAGE_BYTES) {
    return { ok: false, code: 'message-too-large', message: 'Signaling message is too large.' }
  }
  let message
  try { message = JSON.parse(raw) } catch { return { ok: false, code: 'malformed-message', message: 'Malformed JSON message.' } }
  if (!isRecord(message) || message.version !== SIGNALING_VERSION || typeof message.type !== 'string') {
    return { ok: false, code: 'malformed-message', message: 'Invalid signaling envelope.' }
  }
  if (message.type === 'auth') {
    if (message.role === 'editor') {
      const keys = ['version', 'type', 'role', 'accessToken', 'wallId', 'targetDeviceId', 'liveSourceId']
      if (hasOnlyKeys(message, keys) && typeof message.accessToken === 'string' && message.accessToken.length >= 20 && message.accessToken.length <= 8192 && isUuid(message.wallId) && isUuid(message.targetDeviceId) && isUuid(message.liveSourceId)) return { ok: true, message }
    }
    if (message.role === 'player') {
      const keys = ['version', 'type', 'role', 'deviceId', 'deviceToken', 'sessionId']
      if (hasOnlyKeys(message, keys) && isUuid(message.deviceId) && isUuid(message.deviceToken) && SESSION_ID.test(message.sessionId ?? '')) return { ok: true, message }
    }
    return { ok: false, code: 'invalid-auth', message: 'Invalid authentication message.' }
  }
  if (!['peer-ready', 'offer', 'answer', 'ice-candidate', 'session-ended'].includes(message.type)) {
    return { ok: false, code: 'unknown-message', message: 'Unknown signaling message type.' }
  }
  const keys = ['version', 'type', 'sessionId', 'liveSourceId', 'targetDeviceId', 'generation', 'payload']
  if (!hasOnlyKeys(message, keys) || !isScope(message) || !validatePayload(message.type, message.payload)) {
    return { ok: false, code: 'malformed-message', message: 'Invalid signaling message.' }
  }
  return { ok: true, message }
}

export function errorMessage(code, message) {
  return { version: SIGNALING_VERSION, type: 'error', code, message }
}
