import { createClient } from '@supabase/supabase-js'

export function createSupabaseSignalingAuth({ supabaseUrl, serviceRoleKey }) {
  if (!supabaseUrl || !serviceRoleKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.')
  const client = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })

  return {
    async authorizeEditor({ accessToken, sessionId, wallId, targetDeviceId, liveSourceId, expiresAt, signalingUrl }) {
      const { data: userData, error: userError } = await client.auth.getUser(accessToken)
      if (userError || !userData.user) return null
      const { data, error } = await client.rpc('create_live_session_lease', {
        requested_session_id: sessionId,
        requested_wall_id: wallId,
        requested_target_device_id: targetDeviceId,
        requested_live_source_id: liveSourceId,
        requested_controller_user_id: userData.user.id,
        requested_signaling_url: signalingUrl,
        requested_expires_at: expiresAt,
      })
      if (error || !data) return null
      return {
        sessionId: data.session_id,
        wallId: data.wall_id,
        targetDeviceId: data.target_device_id,
        liveSourceId: data.live_source_id,
        controllerUserId: userData.user.id,
        expiresAt: data.expires_at,
      }
    },
    async authorizePlayer({ deviceId, deviceToken, sessionId }) {
      const { data, error } = await client.rpc('validate_live_player', { requested_device_id: deviceId, requested_token: deviceToken, requested_session_id: sessionId })
      if (error || !data) return null
      return { sessionId: data.session_id, wallId: data.wall_id, targetDeviceId: data.target_device_id, liveSourceId: data.live_source_id, expiresAt: data.expires_at }
    },
    async renewLease(scope) {
      const { error } = await client.rpc('renew_live_session_lease', { requested_session_id: scope.sessionId, requested_controller_user_id: scope.controllerUserId, requested_expires_at: scope.expiresAt })
      if (error) throw error
    },
    async endLease(scope) {
      const { error } = await client.rpc('end_live_session_lease', { requested_session_id: scope.sessionId, requested_controller_user_id: scope.controllerUserId })
      if (error) throw error
    },
  }
}
