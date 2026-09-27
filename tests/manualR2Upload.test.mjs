import assert from 'node:assert/strict'
import test from 'node:test'
import { manualR2Upload, signalingHttpOrigin } from '../src/lib/manualR2Upload.ts'

test('signaling WebSocket URL maps to the same backend HTTP origin', () => {
  assert.equal(signalingHttpOrigin('wss://signal.example.com'), 'https://signal.example.com')
  assert.equal(signalingHttpOrigin('ws://127.0.0.1:8787'), 'http://127.0.0.1:8787')
  assert.throws(() => signalingHttpOrigin('https://signal.example.com'), /must use ws:\/\/ or wss:\/\//)
})

test('manual R2 test authorizes with Supabase token then uploads bytes directly', async () => {
  const file = new File([new Uint8Array([1, 2, 3])], 'test image.png', { type: 'image/png' })
  const calls = []
  const fetchRequest = async (url, init) => {
    calls.push({ url, init })
    if (calls.length === 1) return Response.json({
      uploadUrl: 'https://presigned.r2.example/upload',
      objectKey: 'media/12345678-1234-4234-8234-123456789abc/test-image.png',
      publicUrl: 'https://media.example.com/media/12345678-1234-4234-8234-123456789abc/test-image.png',
    })
    return new Response(null, { status: 200 })
  }

  const result = await manualR2Upload(file, 'supabase-access-token', 'wss://signal.example.com', fetchRequest)
  assert.equal(calls[0].url, 'https://signal.example.com/api/media/upload-url')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer supabase-access-token')
  assert.deepEqual(JSON.parse(calls[0].init.body), { filename: 'test image.png', mimeType: 'image/png', sizeBytes: 3 })
  assert.equal(calls[1].url, 'https://presigned.r2.example/upload')
  assert.equal(calls[1].init.method, 'PUT')
  assert.equal(calls[1].init.headers['Content-Type'], 'image/png')
  assert.equal(calls[1].init.body, file)
  assert.deepEqual(result, {
    objectKey: 'media/12345678-1234-4234-8234-123456789abc/test-image.png',
    publicUrl: 'https://media.example.com/media/12345678-1234-4234-8234-123456789abc/test-image.png',
    sizeBytes: 3,
    mimeType: 'image/png',
  })
})

test('manual R2 test surfaces backend and direct-upload errors', async () => {
  const file = new File(['data'], 'test.mp4', { type: 'video/mp4' })
  await assert.rejects(
    manualR2Upload(file, 'token', 'wss://signal.example.com', async () => Response.json({ error: 'mimeType is not supported.' }, { status: 400 })),
    /mimeType is not supported/,
  )

  let call = 0
  await assert.rejects(manualR2Upload(file, 'token', 'wss://signal.example.com', async () => {
    call += 1
    return call === 1
      ? Response.json({ uploadUrl: 'https://presigned.r2.example/upload', objectKey: 'media/key', publicUrl: 'https://media.example.com/media/key' })
      : new Response('', { status: 403, statusText: 'Forbidden' })
  }), /Direct R2 upload failed \(403 Forbidden\)/)

  await assert.rejects(
    manualR2Upload(file, 'token', 'wss://signal.example.com', async () => { throw new TypeError('Failed to fetch') }),
    /Check VITE_SIGNALING_URL and the signaling origin allowlist/,
  )
})
