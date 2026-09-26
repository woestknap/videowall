import { createSignalingServer } from './server.js'
import { createSupabaseSignalingAuth } from './supabaseAuth.js'
import { loadSignalingConfig } from './config.js'

const { port, host, publicUrl, allowedOrigins, maxConnections, maxSessions, supabaseUrl, serviceRoleKey } = loadSignalingConfig()
const auth = createSupabaseSignalingAuth({ supabaseUrl, serviceRoleKey })
const service = createSignalingServer({ auth, port, host, publicUrl, allowedOrigins, maxConnections, maxSessions })

service.wss.on('listening', () => console.log(`Videowall signaling listening on ${host}:${port}; public URL ${publicUrl}; ${allowedOrigins.length} allowed origin(s); capacity ${maxConnections} connections/${maxSessions} sessions.`))

async function shutdown() {
  await service.close()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
