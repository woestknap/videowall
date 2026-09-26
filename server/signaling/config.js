function required(env, name) {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

function positiveInteger(value, fallback, name) {
  const candidate = value === undefined || value === '' ? fallback : Number(value)
  if (!Number.isSafeInteger(candidate) || candidate <= 0) throw new Error(`${name} must be a positive integer.`)
  return candidate
}

function serviceUrl(value, name, protocols) {
  let parsed
  try { parsed = new URL(value) } catch { throw new Error(`${name} must be a valid URL.`) }
  if (!protocols.includes(parsed.protocol)) throw new Error(`${name} must use ${protocols.join(' or ')}.`)
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== '/')) {
    throw new Error(`${name} must be an origin URL without credentials, path, query, or fragment.`)
  }
  return value
}

function allowedOrigins(value) {
  const entries = value.split(',').map(origin => origin.trim()).filter(Boolean)
  if (!entries.length) throw new Error('SIGNALING_ALLOWED_ORIGINS must contain at least one trusted origin.')
  return [...new Set(entries.map(origin => {
    if (origin === '*') throw new Error('SIGNALING_ALLOWED_ORIGINS must not contain a wildcard.')
    const validated = serviceUrl(origin, 'SIGNALING_ALLOWED_ORIGINS entry', ['http:', 'https:'])
    return new URL(validated).origin
  }))]
}

export function loadSignalingConfig(env = process.env) {
  const port = positiveInteger(env.SIGNALING_PORT, 8787, 'SIGNALING_PORT')
  if (port > 65535) throw new Error('SIGNALING_PORT must be at most 65535.')
  const host = env.SIGNALING_HOST?.trim() || '0.0.0.0'
  const publicUrl = serviceUrl(required(env, 'PUBLIC_SIGNALING_URL'), 'PUBLIC_SIGNALING_URL', ['ws:', 'wss:'])
  const origins = allowedOrigins(required(env, 'SIGNALING_ALLOWED_ORIGINS'))
  const supabaseUrl = serviceUrl(required(env, 'SUPABASE_URL'), 'SUPABASE_URL', ['http:', 'https:'])
  const serviceRoleKey = required(env, 'SUPABASE_SERVICE_ROLE_KEY')
  return {
    port,
    host,
    publicUrl,
    allowedOrigins: origins,
    maxConnections: positiveInteger(env.SIGNALING_MAX_CONNECTIONS, 200, 'SIGNALING_MAX_CONNECTIONS'),
    maxSessions: positiveInteger(env.SIGNALING_MAX_SESSIONS, 100, 'SIGNALING_MAX_SESSIONS'),
    supabaseUrl,
    serviceRoleKey,
  }
}
