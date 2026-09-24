import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WebSocket } from 'ws'
import { createSignalingServer } from '../server/signaling/server.js'

const WALL_A = '11111111-1111-4111-8111-111111111111'
const WALL_B = '22222222-2222-4222-8222-222222222222'
const DEVICE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DEVICE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SOURCE_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const SOURCE_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const TOKEN_A = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const TOKEN_B = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const ACCESS_TOKEN = 'valid-editor-access-token'

function fakeAuth() {
  const leases = new Map()
  return {
    leases,
    async authorizeEditor(input) {
      if (input.accessToken !== ACCESS_TOKEN || input.wallId !== WALL_A) return null
      const expectedWall = input.targetDeviceId === DEVICE_A ? WALL_A : WALL_B
      if (expectedWall !== input.wallId) return null
      const scope = { sessionId: input.sessionId, wallId: input.wallId, targetDeviceId: input.targetDeviceId, liveSourceId: input.liveSourceId, controllerUserId: 'user-a', expiresAt: input.expiresAt }
      leases.set(input.sessionId, scope)
      return scope
    },
    async authorizePlayer(input) {
      const lease = leases.get(input.sessionId)
      const token = input.deviceId === DEVICE_A ? TOKEN_A : input.deviceId === DEVICE_B ? TOKEN_B : null
      if (!lease || input.deviceToken !== token || input.deviceId !== lease.targetDeviceId) return null
      return { ...lease }
    },
    async renewLease(scope) { const lease = leases.get(scope.sessionId); if (!lease) throw new Error('missing'); lease.expiresAt = scope.expiresAt },
    async endLease(scope) { leases.delete(scope.sessionId) },
  }
}

async function fixture(run) {
  const auth = fakeAuth()
  const service = createSignalingServer({ auth, port: 0, publicUrl: 'ws://127.0.0.1' })
  await new Promise((resolve) => service.wss.once('listening', resolve))
  const address = service.wss.address()
  const url = `ws://127.0.0.1:${address.port}`
  const clients = []
  const open = async () => {
    const client = new WebSocket(url)
    clients.push(client)
    await new Promise((resolve, reject) => { client.once('open', resolve); client.once('error', reject) })
    return client
  }
  try { await run({ auth, service, open }) } finally {
    for (const client of clients) client.terminate()
    await service.close()
  }
}

function nextMessage(socket, timeout = 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('message timeout')) }, timeout)
    const onMessage = (data) => { cleanup(); resolve(JSON.parse(data.toString())) }
    const onClose = () => { cleanup(); reject(new Error('socket closed')) }
    const cleanup = () => { clearTimeout(timer); socket.off('message', onMessage); socket.off('close', onClose) }
    socket.on('message', onMessage)
    socket.on('close', onClose)
  })
}

function editorAuth(overrides = {}) {
  return { version: 1, type: 'auth', role: 'editor', accessToken: ACCESS_TOKEN, wallId: WALL_A, targetDeviceId: DEVICE_A, liveSourceId: SOURCE_A, ...overrides }
}

function playerAuth(sessionId, overrides = {}) {
  return { version: 1, type: 'auth', role: 'player', deviceId: DEVICE_A, deviceToken: TOKEN_A, sessionId, ...overrides }
}

async function authenticateEditor(open, overrides = {}) {
  const socket = await open()
  const response = nextMessage(socket)
  socket.send(JSON.stringify(editorAuth(overrides)))
  return { socket, authenticated: await response }
}

test('valid editor joins a valid session', () => fixture(async ({ open, service }) => {
  const { authenticated } = await authenticateEditor(open)
  assert.equal(authenticated.type, 'authenticated')
  assert.equal(authenticated.role, 'editor')
  assert.equal(authenticated.wallId, WALL_A)
  assert.equal(service.sessions.size, 1)
}))

test('valid target Pi joins and reports peer-ready', () => fixture(async ({ open }) => {
  const { socket: editor, authenticated } = await authenticateEditor(open)
  const player = await open()
  const playerResponse = nextMessage(player)
  player.send(JSON.stringify(playerAuth(authenticated.sessionId)))
  const playerScope = await playerResponse
  assert.equal(playerScope.role, 'player')
  const readyAtEditor = nextMessage(editor)
  player.send(JSON.stringify({ version: 1, type: 'peer-ready', sessionId: playerScope.sessionId, liveSourceId: playerScope.liveSourceId, targetDeviceId: playerScope.targetDeviceId, generation: playerScope.generation, payload: {} }))
  assert.equal((await readyAtEditor).type, 'peer-ready')
}))

test('offer, answer, and ICE candidate envelopes relay only between bound peers', () => fixture(async ({ open }) => {
  const { socket: editor, authenticated: editorScope } = await authenticateEditor(open)
  const player = await open()
  const playerResponse = nextMessage(player)
  player.send(JSON.stringify(playerAuth(editorScope.sessionId)))
  const playerScope = await playerResponse
  const envelope = (type, payload) => ({ version: 1, type, sessionId: editorScope.sessionId, liveSourceId: editorScope.liveSourceId, targetDeviceId: editorScope.targetDeviceId, generation: editorScope.generation, payload })

  const offerAtPlayer = nextMessage(player)
  editor.send(JSON.stringify(envelope('offer', { sdp: 'future-offer-sdp' })))
  assert.equal((await offerAtPlayer).payload.sdp, 'future-offer-sdp')

  const answerAtEditor = nextMessage(editor)
  player.send(JSON.stringify({ ...envelope('answer', { sdp: 'future-answer-sdp' }), generation: playerScope.generation }))
  assert.equal((await answerAtEditor).payload.sdp, 'future-answer-sdp')

  const candidateAtPlayer = nextMessage(player)
  editor.send(JSON.stringify(envelope('ice-candidate', { candidate: 'future-candidate', sdpMid: '0', sdpMLineIndex: 0 })))
  assert.equal((await candidateAtPlayer).payload.candidate, 'future-candidate')
}))

test('wrong Pi/device is rejected', () => fixture(async ({ open }) => {
  const { authenticated } = await authenticateEditor(open)
  const player = await open()
  const response = nextMessage(player)
  player.send(JSON.stringify(playerAuth(authenticated.sessionId, { deviceId: DEVICE_B, deviceToken: TOKEN_B })))
  assert.equal((await response).code, 'unauthorized')
}))

test('wrong wall is rejected', () => fixture(async ({ open, service }) => {
  const editor = await open()
  const response = nextMessage(editor)
  editor.send(JSON.stringify(editorAuth({ wallId: WALL_B })))
  assert.equal((await response).code, 'unauthorized')
  assert.equal(service.sessions.size, 0)
}))

test('expired session is rejected', () => fixture(async ({ open, auth }) => {
  const { authenticated } = await authenticateEditor(open)
  auth.leases.get(authenticated.sessionId).expiresAt = new Date(0).toISOString()
  const player = await open()
  const response = nextMessage(player)
  player.send(JSON.stringify(playerAuth(authenticated.sessionId)))
  assert.equal((await response).code, 'unauthorized')
}))

test('malformed signaling message is rejected', () => fixture(async ({ open }) => {
  const socket = await open()
  const response = nextMessage(socket)
  socket.send('{not-json')
  assert.equal((await response).code, 'malformed-message')
}))

test('cross-session signaling cannot be relayed', () => fixture(async ({ open }) => {
  const { authenticated: first } = await authenticateEditor(open)
  const { socket: secondEditor, authenticated: second } = await authenticateEditor(open, { liveSourceId: SOURCE_B })
  const player = await open()
  const playerResponse = nextMessage(player)
  player.send(JSON.stringify(playerAuth(first.sessionId)))
  const playerScope = await playerResponse
  const rejection = nextMessage(player)
  let leaked = false
  secondEditor.once('message', () => { leaked = true })
  player.send(JSON.stringify({ version: 1, type: 'ice-candidate', sessionId: second.sessionId, liveSourceId: second.liveSourceId, targetDeviceId: second.targetDeviceId, generation: playerScope.generation, payload: { candidate: null, sdpMid: null, sdpMLineIndex: null } }))
  assert.equal((await rejection).code, 'scope-mismatch')
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(leaked, false)
}))

test('disconnect cleans up peer and session state', () => fixture(async ({ open, service, auth }) => {
  const { socket: editor, authenticated } = await authenticateEditor(open)
  const player = await open()
  const playerResponse = nextMessage(player)
  player.send(JSON.stringify(playerAuth(authenticated.sessionId)))
  await playerResponse
  player.close()
  await new Promise((resolve) => player.once('close', resolve))
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(service.sessions.get(authenticated.sessionId).player, null)
  editor.close()
  await new Promise((resolve) => editor.once('close', resolve))
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(service.sessions.size, 0)
  assert.equal(auth.leases.size, 0)
}))
