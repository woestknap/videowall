import { randomBytes } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'
import { errorMessage, MAX_SIGNALING_MESSAGE_BYTES, parseClientMessage, SIGNALING_VERSION } from './protocol.js'

const SESSION_TTL_MS = 45_000
const RENEW_INTERVAL_MS = 15_000

function sessionId() {
  return randomBytes(24).toString('base64url')
}

function sameScope(left, right) {
  return left.sessionId === right.sessionId && left.wallId === right.wallId && left.targetDeviceId === right.targetDeviceId && left.liveSourceId === right.liveSourceId
}

function publicScope(scope, role) {
  return {
    version: SIGNALING_VERSION,
    type: 'authenticated',
    role,
    sessionId: scope.sessionId,
    wallId: scope.wallId,
    targetDeviceId: scope.targetDeviceId,
    liveSourceId: scope.liveSourceId,
    generation: scope.generation,
    expiresAt: scope.expiresAt,
  }
}

function scopedMessage(scope, type, payload) {
  return { version: SIGNALING_VERSION, type, sessionId: scope.sessionId, liveSourceId: scope.liveSourceId, targetDeviceId: scope.targetDeviceId, generation: scope.generation, payload }
}

export function createSignalingServer({ auth, port = 0, host = '127.0.0.1', publicUrl, allowedOrigins = [], maxConnections = 200, maxSessions = 100, now = () => Date.now() }) {
  const sessions = new Map()
  const sockets = new Set()
  const wss = new WebSocketServer({ port, host, maxPayload: MAX_SIGNALING_MESSAGE_BYTES })

  function send(socket, message) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
  }

  function reject(socket, code, message, closeCode = 1008) {
    send(socket, errorMessage(code, message))
    socket.close(closeCode, code.slice(0, 123))
  }

  async function endSession(session, reason, initiator) {
    if (!sessions.has(session.scope.sessionId)) return
    sessions.delete(session.scope.sessionId)
    clearInterval(session.renewTimer)
    const ended = scopedMessage(session.scope, 'session-ended', { reason })
    for (const peer of [session.editor, session.player]) {
      if (peer && peer !== initiator) send(peer, ended)
      if (peer) peer.binding = null
      if (peer && peer !== initiator && peer.readyState === WebSocket.OPEN) peer.close(1000, 'session-ended')
    }
    await auth.endLease?.(session.scope).catch(() => undefined)
  }

  function scopeMatchesMessage(scope, message) {
    return message.sessionId === scope.sessionId && message.liveSourceId === scope.liveSourceId && message.targetDeviceId === scope.targetDeviceId && message.generation === scope.generation
  }

  async function authenticateEditor(socket, message) {
    if (sessions.size >= maxSessions) return reject(socket, 'capacity', 'The signaling service is at session capacity.', 1013)
    const id = sessionId()
    const expiresAt = new Date(now() + SESSION_TTL_MS).toISOString()
    const scope = await auth.authorizeEditor({ ...message, sessionId: id, expiresAt, signalingUrl: publicUrl })
    if (!scope || scope.sessionId !== id || scope.wallId !== message.wallId || scope.targetDeviceId !== message.targetDeviceId || scope.liveSourceId !== message.liveSourceId) {
      return reject(socket, 'unauthorized', 'Editor is not authorized for this live session.')
    }
    scope.generation = 1
    scope.expiresAt = expiresAt
    for (const existing of sessions.values()) {
      if (existing.scope.targetDeviceId === scope.targetDeviceId && existing.scope.liveSourceId === scope.liveSourceId) await endSession(existing, 'replaced')
    }
    const session = { scope, editor: socket, player: null, renewTimer: null }
    sessions.set(id, session)
    socket.binding = { role: 'editor', session }
    session.renewTimer = setInterval(async () => {
      if (socket.readyState !== WebSocket.OPEN) return
      const nextExpiry = new Date(now() + SESSION_TTL_MS).toISOString()
      try {
        await auth.renewLease?.({ ...scope, expiresAt: nextExpiry })
        scope.expiresAt = nextExpiry
      } catch {
        await endSession(session, 'signaling-error')
        socket.close(1011, 'lease-renewal-failed')
      }
    }, RENEW_INTERVAL_MS)
    session.renewTimer.unref?.()
    send(socket, publicScope(scope, 'editor'))
  }

  async function authenticatePlayer(socket, message) {
    const scope = await auth.authorizePlayer(message)
    const session = scope ? sessions.get(scope.sessionId) : null
    if (!scope || !session || !sameScope(scope, session.scope) || scope.expiresAt <= new Date(now()).toISOString()) {
      return reject(socket, 'unauthorized', 'Player is not authorized for this live session.')
    }
    if (session.player && session.player !== socket) {
      session.player.binding = null
      session.player.close(1008, 'replaced')
    }
    session.player = socket
    socket.binding = { role: 'player', session }
    send(socket, publicScope(session.scope, 'player'))
  }

  async function onMessage(socket, data, isBinary) {
    if (isBinary) return reject(socket, 'malformed-message', 'Binary signaling messages are not supported.')
    const parsed = parseClientMessage(data.toString())
    if (!parsed.ok) return reject(socket, parsed.code, parsed.message, parsed.code === 'message-too-large' ? 1009 : 1008)
    const message = parsed.message
    if (!socket.binding) {
      if (message.type !== 'auth') return reject(socket, 'authentication-required', 'Authenticate before signaling.')
      try {
        if (message.role === 'editor') await authenticateEditor(socket, message)
        else await authenticatePlayer(socket, message)
      } catch {
        reject(socket, 'unauthorized', 'Authentication failed.')
      }
      return
    }
    if (message.type === 'auth') return reject(socket, 'already-authenticated', 'This connection is already authenticated.')
    const { role, session } = socket.binding
    if (!sessions.has(session.scope.sessionId) || !scopeMatchesMessage(session.scope, message)) return reject(socket, 'scope-mismatch', 'Signaling scope does not match the authenticated session.')
    if ((message.type === 'peer-ready' || message.type === 'answer') && role !== 'player') return reject(socket, 'role-forbidden', 'Message is not allowed for this role.')
    if (message.type === 'offer' && role !== 'editor') return reject(socket, 'role-forbidden', 'Message is not allowed for this role.')
    if (message.type === 'session-ended') {
      await endSession(session, message.payload.reason, socket)
      socket.close(1000, 'session-ended')
      return
    }
    const peer = role === 'editor' ? session.player : session.editor
    if (!peer) return send(socket, errorMessage('peer-unavailable', 'The other peer is not connected.'))
    send(peer, message)
  }

  wss.on('connection', (socket, request) => {
    if (sockets.size >= maxConnections) return reject(socket, 'capacity', 'The signaling service is at connection capacity.', 1013)
    const origin = request.headers.origin
    if (allowedOrigins.length && (!origin || !allowedOrigins.includes(origin))) return reject(socket, 'origin-rejected', 'Origin is not allowed.')
    sockets.add(socket)
    socket.binding = null
    socket.on('message', (data, isBinary) => void onMessage(socket, data, isBinary))
    socket.on('close', () => {
      sockets.delete(socket)
      const binding = socket.binding
      socket.binding = null
      if (!binding) return
      const { role, session } = binding
      if (role === 'editor') void endSession(session, 'controller-stopped', socket)
      else if (session.player === socket) {
        session.player = null
        send(session.editor, scopedMessage(session.scope, 'session-ended', { reason: 'player-left' }))
      }
    })
    socket.on('error', () => undefined)
  })

  const expiryTimer = setInterval(() => {
    for (const session of sessions.values()) {
      if (new Date(session.scope.expiresAt).getTime() <= now()) void endSession(session, 'expired')
    }
  }, 1000)
  expiryTimer.unref?.()

  return {
    wss,
    sessions,
    async close() {
      clearInterval(expiryTimer)
      for (const session of [...sessions.values()]) await endSession(session, 'signaling-error')
      for (const socket of sockets) socket.terminate()
      await new Promise((resolve) => wss.close(resolve))
    },
  }
}
