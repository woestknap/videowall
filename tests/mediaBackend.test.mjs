import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { loadMediaConfig } from '../server/media/config.js'
import { createMediaHttpHandler } from '../server/media/http.js'
import {
  createMediaObjectKey,
  createR2MediaStore,
  MAX_MEDIA_UPLOAD_BYTES,
  publicMediaUrl,
  safeMediaFilename,
} from '../server/media/r2.js'

const MEDIA_ID = '12345678-1234-4234-8234-123456789abc'
const OBJECT_KEY = `media/${MEDIA_ID}/summer-party.mp4`
const baseConfig = {
  R2_ACCOUNT_ID: '1234567890abcdef1234567890abcdef',
  R2_ACCESS_KEY_ID: 'server-access-key',
  R2_SECRET_ACCESS_KEY: 'server-secret-key',
  R2_BUCKET_NAME: 'videowall-media',
  R2_PUBLIC_BASE_URL: 'https://media.example.com',
}

test('R2 configuration requires every server-only value', () => {
  for (const name of Object.keys(baseConfig)) {
    assert.throws(() => loadMediaConfig({ ...baseConfig, [name]: '' }), new RegExp(`${name} is required`))
  }
  assert.equal(loadMediaConfig({ ...baseConfig, R2_PUBLIC_BASE_URL: 'https://media.example.com/' }).publicBaseUrl, 'https://media.example.com')
  assert.throws(() => loadMediaConfig({ ...baseConfig, R2_ACCOUNT_ID: 'not-an-account' }), /32-character Cloudflare account ID/)
  assert.throws(() => loadMediaConfig({ ...baseConfig, R2_PUBLIC_BASE_URL: 'http://media.example.com' }), /must use https/)
})

test('media filenames and keys are sanitized and use a generated UUID namespace', () => {
  assert.equal(safeMediaFilename('  Café launch FINAL!!.MOV', 'video/mp4'), 'Cafe-launch-FINAL.mp4')
  assert.equal(createMediaObjectKey({ filename: 'summer party.mov', mimeType: 'video/mp4', id: MEDIA_ID }), OBJECT_KEY)
  assert.throws(() => createMediaObjectKey({ filename: '../secret.mp4', mimeType: 'video/mp4', id: MEDIA_ID }), /safe file name/)
  assert.throws(() => createMediaObjectKey({ filename: 'payload.exe', mimeType: 'application/octet-stream', id: MEDIA_ID }), /not supported/)
})

test('public playback URL is stable and rejects keys outside the managed namespace', () => {
  assert.equal(publicMediaUrl('https://media.example.com/', OBJECT_KEY), `https://media.example.com/${OBJECT_KEY}`)
  assert.throws(() => publicMediaUrl('https://media.example.com', '../private/object'), /managed media namespace/)
})

test('R2 store signs a constrained PUT without sending bytes through Node', async () => {
  const client = { send: async () => assert.fail('PUT signing must not send an object') }
  let signed
  const store = createR2MediaStore({
    accountId: 'account', accessKeyId: 'key', secretAccessKey: 'secret', bucketName: 'bucket', publicBaseUrl: 'https://media.example.com',
  }, {
    client,
    randomUUID: () => MEDIA_ID,
    sign: async (actualClient, command, options) => {
      signed = { actualClient, command, options }
      return 'https://signed-upload.example.test'
    },
  })

  const result = await store.createUploadAuthorization({ filename: 'summer party.mov', mimeType: 'video/mp4', sizeBytes: 1234 })
  assert.equal(signed.actualClient, client)
  assert.ok(signed.command instanceof PutObjectCommand)
  assert.deepEqual(signed.command.input, { Bucket: 'bucket', Key: OBJECT_KEY, ContentType: 'video/mp4', ContentLength: 1234 })
  assert.equal(signed.options.expiresIn, 300)
  assert.deepEqual(result, {
    uploadUrl: 'https://signed-upload.example.test',
    objectKey: OBJECT_KEY,
    publicUrl: `https://media.example.com/${OBJECT_KEY}`,
    expiresIn: 300,
  })
})

test('R2 deletion accepts only generated media keys in the configured bucket', async () => {
  const commands = []
  const store = createR2MediaStore({
    accountId: 'account', accessKeyId: 'key', secretAccessKey: 'secret', bucketName: 'bucket', publicBaseUrl: 'https://media.example.com',
  }, { client: { send: async command => commands.push(command) } })

  await assert.rejects(store.deleteObject('other/prefix/file.mp4'), /managed media namespace/)
  await assert.rejects(store.deleteObject('media/../../private'), /managed media namespace/)
  assert.equal(commands.length, 0)
  await store.deleteObject(OBJECT_KEY)
  assert.ok(commands[0] instanceof DeleteObjectCommand)
  assert.deepEqual(commands[0].input, { Bucket: 'bucket', Key: OBJECT_KEY })
})

async function withMediaApi(run) {
  const calls = []
  const handler = createMediaHttpHandler({
    allowedOrigins: ['http://localhost:5173', 'https://videowall-3lp.pages.dev'],
    auth: { async authenticateEditor(token) { return token === 'valid-token' ? { id: 'user-id' } : null } },
    mediaStore: {
      async createUploadAuthorization(body) {
        calls.push(['upload', body])
        if (!['image/jpeg', 'image/png', 'image/webp', 'video/mp4'].includes(body.mimeType)) throw new TypeError('mimeType is not supported.')
        if (!Number.isSafeInteger(body.sizeBytes) || body.sizeBytes <= 0 || body.sizeBytes > MAX_MEDIA_UPLOAD_BYTES) throw new TypeError('sizeBytes is invalid.')
        return { uploadUrl: 'https://signed.example.test', objectKey: OBJECT_KEY, publicUrl: `https://media.example.com/${OBJECT_KEY}`, expiresIn: 300 }
      },
      async deleteObject(objectKey) { calls.push(['delete', objectKey]) },
    },
  })
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  try { await run({ baseUrl: `http://127.0.0.1:${address.port}`, calls }) }
  finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}

function mediaRequest(baseUrl, path, { method = 'POST', token, body, origin = 'http://localhost:5173' } = {}) {
  const headers = { 'Content-Type': 'application/json', Origin: origin }
  if (token) headers.Authorization = `Bearer ${token}`
  return fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
}

function preflight(baseUrl, origin) {
  return fetch(`${baseUrl}/api/media/upload-url`, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type',
    },
  })
}

function assertAllowedCors(response, origin) {
  assert.equal(response.headers.get('access-control-allow-origin'), origin)
  assert.equal(response.headers.get('vary'), 'Origin')
  assert.notEqual(response.headers.get('access-control-allow-origin'), '*')
}

for (const [name, origin] of [['localhost', 'http://localhost:5173'], ['production Pages', 'https://videowall-3lp.pages.dev']]) {
  test(`media API allows ${name} OPTIONS preflight`, () => withMediaApi(async ({ baseUrl, calls }) => {
    const response = await preflight(baseUrl, origin)
    assert.equal(response.status, 204)
    assertAllowedCors(response, origin)
    assert.equal(response.headers.get('access-control-allow-methods'), 'POST, DELETE, OPTIONS')
    assert.equal(response.headers.get('access-control-allow-headers'), 'Authorization, Content-Type')
    assert.equal(response.headers.get('access-control-max-age'), '3600')
    assert.equal(await response.text(), '')
    assert.equal(calls.length, 0)
  }))
}

test('media upload endpoint rejects missing editor authentication', () => withMediaApi(async ({ baseUrl, calls }) => {
  const response = await mediaRequest(baseUrl, '/api/media/upload-url', { body: { filename: 'x.png', mimeType: 'image/png', sizeBytes: 10 } })
  assert.equal(response.status, 401)
  assertAllowedCors(response, 'http://localhost:5173')
  assert.equal(calls.length, 0)
}))

test('media upload endpoint rejects unsupported MIME and excessive size', () => withMediaApi(async ({ baseUrl }) => {
  const unsupported = await mediaRequest(baseUrl, '/api/media/upload-url', { token: 'valid-token', body: { filename: 'x.exe', mimeType: 'application/octet-stream', sizeBytes: 10 } })
  assert.equal(unsupported.status, 400)
  const oversized = await mediaRequest(baseUrl, '/api/media/upload-url', { token: 'valid-token', body: { filename: 'x.mp4', mimeType: 'video/mp4', sizeBytes: MAX_MEDIA_UPLOAD_BYTES + 1 } })
  assert.equal(oversized.status, 400)
}))

test('media HTTP API returns upload authorization, deletes by key, and preserves fallback response', () => withMediaApi(async ({ baseUrl, calls }) => {
  const upload = await mediaRequest(baseUrl, '/api/media/upload-url', { token: 'valid-token', body: { filename: 'x.png', mimeType: 'image/png', sizeBytes: 10 } })
  assert.equal(upload.status, 200)
  assertAllowedCors(upload, 'http://localhost:5173')
  assert.equal((await upload.json()).objectKey, OBJECT_KEY)
  const deletion = await mediaRequest(baseUrl, '/api/media/object', { method: 'DELETE', token: 'valid-token', body: { objectKey: OBJECT_KEY } })
  assert.equal(deletion.status, 204)
  assert.deepEqual(calls.map(call => call[0]), ['upload', 'delete'])
  assert.equal((await fetch(`${baseUrl}/`)).status, 426)
}))

test('media HTTP API rejects browser origins outside the signaling allowlist', () => withMediaApi(async ({ baseUrl, calls }) => {
  const response = await mediaRequest(baseUrl, '/api/media/upload-url', { token: 'valid-token', origin: 'https://evil.example', body: { filename: 'x.png', mimeType: 'image/png', sizeBytes: 10 } })
  assert.equal(response.status, 403)
  assert.equal(response.headers.get('access-control-allow-origin'), null)
  assert.equal(response.headers.get('access-control-allow-methods'), null)
  assert.equal(calls.length, 0)
}))

test('media API error and unknown-route responses preserve an allowed exact origin', () => withMediaApi(async ({ baseUrl }) => {
  const badRequest = await mediaRequest(baseUrl, '/api/media/upload-url', { token: 'valid-token', body: { filename: 'x.exe', mimeType: 'application/octet-stream', sizeBytes: 10 } })
  assert.equal(badRequest.status, 400)
  assertAllowedCors(badRequest, 'http://localhost:5173')

  const notFound = await mediaRequest(baseUrl, '/api/media/unknown', { token: 'valid-token', body: {} })
  assert.equal(notFound.status, 404)
  assertAllowedCors(notFound, 'http://localhost:5173')
}))

test('media API requests without Origin continue through normal authentication', () => withMediaApi(async ({ baseUrl }) => {
  const response = await fetch(`${baseUrl}/api/media/upload-url`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(response.status, 401)
  assert.equal(response.headers.get('access-control-allow-origin'), null)
}))
