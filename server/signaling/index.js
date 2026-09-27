import { createSignalingServer } from './server.js'
import { createSupabaseSignalingAuth } from './supabaseAuth.js'
import { loadSignalingConfig } from './config.js'
import { loadMediaConfig } from '../media/config.js'
import { createMediaHttpHandler } from '../media/http.js'
import { createR2MediaStore } from '../media/r2.js'

const { port, host, publicUrl, allowedOrigins, maxConnections, maxSessions, supabaseUrl, serviceRoleKey } = loadSignalingConfig()
const auth = createSupabaseSignalingAuth({ supabaseUrl, serviceRoleKey })
const mediaStore = createR2MediaStore(loadMediaConfig())
const requestHandler = createMediaHttpHandler({ auth, mediaStore, allowedOrigins })
const service = createSignalingServer({ auth, port, host, publicUrl, allowedOrigins, maxConnections, maxSessions, requestHandler })

service.wss.on('listening', () => console.log(`Videowall signaling listening on ${host}:${port}; public URL ${publicUrl}; ${allowedOrigins.length} allowed origin(s); capacity ${maxConnections} connections/${maxSessions} sessions.`))

async function shutdown() {
  await service.close()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
