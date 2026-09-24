import { createSignalingServer } from './server.js'
import { createSupabaseSignalingAuth } from './supabaseAuth.js'

const port = Number(process.env.SIGNALING_PORT ?? 8787)
const host = process.env.SIGNALING_HOST ?? '0.0.0.0'
const publicUrl = process.env.PUBLIC_SIGNALING_URL ?? `ws://localhost:${port}`
const allowedOrigins = (process.env.SIGNALING_ALLOWED_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean)
const auth = createSupabaseSignalingAuth({ supabaseUrl: process.env.SUPABASE_URL, serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY })
const service = createSignalingServer({ auth, port, host, publicUrl, allowedOrigins })

service.wss.on('listening', () => console.log(`Videowall signaling listening on port ${port}`))

async function shutdown() {
  await service.close()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
