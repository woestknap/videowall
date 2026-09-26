import assert from 'node:assert/strict'
import test from 'node:test'
import { loadSignalingConfig } from '../server/signaling/config.js'

const base = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'server-only-secret',
  PUBLIC_SIGNALING_URL: 'ws://192.168.1.50:8787',
  SIGNALING_ALLOWED_ORIGINS: 'http://localhost:5173',
}

test('local signaling configuration keeps explicit LAN discovery URL', () => {
  assert.deepEqual(loadSignalingConfig(base), {
    port: 8787,
    host: '0.0.0.0',
    publicUrl: 'ws://192.168.1.50:8787',
    allowedOrigins: ['http://localhost:5173'],
    maxConnections: 200,
    maxSessions: 100,
    supabaseUrl: 'https://project.supabase.co',
    serviceRoleKey: 'server-only-secret',
  })
})

test('production configuration accepts stable WSS and exact comma-separated origins', () => {
  const config = loadSignalingConfig({
    ...base,
    PUBLIC_SIGNALING_URL: 'wss://signal.example.com',
    SIGNALING_ALLOWED_ORIGINS: ' https://videowall.example.com,https://preview.example.com/,https://videowall.example.com ',
    SIGNALING_HOST: '127.0.0.1',
    SIGNALING_PORT: '9876',
    SIGNALING_MAX_CONNECTIONS: '50',
    SIGNALING_MAX_SESSIONS: '25',
  })
  assert.equal(config.publicUrl, 'wss://signal.example.com')
  assert.deepEqual(config.allowedOrigins, ['https://videowall.example.com', 'https://preview.example.com'])
  assert.equal(config.host, '127.0.0.1')
  assert.equal(config.port, 9876)
  assert.equal(config.maxConnections, 50)
  assert.equal(config.maxSessions, 25)
})

test('required server-only configuration fails clearly before startup', () => {
  for (const name of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'PUBLIC_SIGNALING_URL', 'SIGNALING_ALLOWED_ORIGINS']) {
    assert.throws(() => loadSignalingConfig({ ...base, [name]: '' }), new RegExp(`${name} is required`))
  }
})

test('public URL and origin allowlist reject insecure configuration shapes', () => {
  assert.throws(() => loadSignalingConfig({ ...base, PUBLIC_SIGNALING_URL: 'https://signal.example.com' }), /PUBLIC_SIGNALING_URL must use ws: or wss:/)
  assert.throws(() => loadSignalingConfig({ ...base, PUBLIC_SIGNALING_URL: 'wss://signal.example.com/private' }), /without credentials, path, query, or fragment/)
  assert.throws(() => loadSignalingConfig({ ...base, SIGNALING_ALLOWED_ORIGINS: '*' }), /must not contain a wildcard/)
  assert.throws(() => loadSignalingConfig({ ...base, SIGNALING_ALLOWED_ORIGINS: 'https://example.com/editor' }), /without credentials, path, query, or fragment/)
})

test('ports and capacity limits must be valid positive integers', () => {
  assert.throws(() => loadSignalingConfig({ ...base, SIGNALING_PORT: '70000' }), /at most 65535/)
  assert.throws(() => loadSignalingConfig({ ...base, SIGNALING_PORT: 'nope' }), /positive integer/)
  assert.throws(() => loadSignalingConfig({ ...base, SIGNALING_MAX_CONNECTIONS: '0' }), /positive integer/)
  assert.throws(() => loadSignalingConfig({ ...base, SIGNALING_MAX_SESSIONS: '1.5' }), /positive integer/)
})
