import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { formatPlaylistActivationRemaining, formatPlaylistRemaining, PLAYLIST_ACTIVATION_LEAD_MS, PLAYLIST_LOADING_LEAD_MS, playlistActivationRemainingMs, playlistLoadingOverlayState, playlistPollIntervalMs, playlistPresentationSkewMs, playlistRemainingMs, playlistRuntimeLabel } from '../src/lib/playlistRuntime.ts'

const runtime = {
  wall_id: 'wall', playlist_id: 'playlist', playlist_name: 'Morning', status: 'PLAYING', phase: 'DISPLAYING',
  generation: 'generation', sequence: 4, current_index: 1, item_count: 3, current_item_id: 'item', current_scene_id: 'scene', current_scene_name: 'Promo',
  target_index: null, target_item_id: null, target_scene_id: null, target_scene_name: null, loading_scene_id: null,
  started_at: '2026-09-28T10:00:00Z', next_transition_at: '2026-09-28T10:01:30Z', paused_remaining_ms: null,
  transition_deadline_at: null, loading_at: null, activation_at: null, expected_count: 2, ready_count: 2, failed_device_ids: [], degraded: false, updated_at: '2026-09-28T10:00:00Z',
}

test('countdown derives locally from authoritative timestamps and pause retains remaining time', () => {
  assert.equal(playlistRemainingMs(runtime, Date.parse('2026-09-28T10:00:18Z')), 72_000)
  assert.equal(formatPlaylistRemaining(72_000), '01:12')
  assert.equal(playlistRemainingMs({ ...runtime, status: 'PAUSED', next_transition_at: null, paused_remaining_ms: 31_250 }), 31_250)
  assert.equal(playlistRuntimeLabel({ ...runtime, phase: 'PREPARING' }), 'PREPARING')
})

test('runtime migration snapshots ordered item identities, scenes, durations, loop and loading scene', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20260928150000_playlist_runtime.sql', import.meta.url), 'utf8')
  assert.match(sql, /create table public\.playlist_runtime/i)
  assert.match(sql, /generation uuid not null/i)
  assert.match(sql, /sequence bigint not null/i)
  assert.match(sql, /'loop', playlist\.loop/i)
  assert.match(sql, /'loading_scene_id', playlist\.loading_scene_id/i)
  assert.match(sql, /'item_id', item\.id[\s\S]*'scene_id', item\.scene_id[\s\S]*'duration_seconds', item\.duration_seconds[\s\S]*order by item\.position/i)
  assert.match(sql, /playlist\.loop[\s\S]*snapshot/i)
})

test('corrective Start migration selects every playlist value it snapshots', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20260929090000_playlist_start_record_shape_fix.sql', import.meta.url), 'utf8')
  const body = sql.slice(sql.indexOf('as $$'))
  assert.match(sql, /create or replace function public\.start_playlist\(requested_wall_id uuid, requested_playlist_id uuid\)/i)
  assert.match(sql, /select p\.id, p\.wall_id, p\.name, p\.loop, p\.loading_scene_id\s+into playlist_id, playlist_wall_id, playlist_name, playlist_loop, playlist_loading_scene_id/i)
  assert.match(sql, /'loop', playlist_loop/i)
  assert.match(sql, /'loading_scene_id', playlist_loading_scene_id/i)
  assert.match(sql, /scene\.wall_id = playlist_wall_id/i)
  assert.match(sql, /where item\.playlist_id = playlist_id/i)
  assert.doesNotMatch(body, /playlist\.loop|playlist\.loading_scene_id|playlist\.wall_id|playlist\.id|playlist\.name/i)
  assert.match(sql, /security definer[\s\S]*set search_path = public/i)
  assert.match(sql, /revoke all on function public\.start_playlist\(uuid, uuid\) from public, anon[\s\S]*grant execute on function public\.start_playlist\(uuid, uuid\) to authenticated/i)
})

test('latest Start migration avoids playlist identifier collisions with explicit aliases', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20260929093000_playlist_start_identifier_collision_fix.sql', import.meta.url), 'utf8')
  assert.match(sql, /declare[\s\S]*v_playlist_id uuid[\s\S]*v_generation uuid/i)
  assert.match(sql, /from public\.playlists p\s+where p\.id = requested_playlist_id and p\.wall_id = requested_wall_id/i)
  assert.match(sql, /from public\.playlist_items pi\s+join public\.scenes s on s\.id = pi\.scene_id and s\.wall_id = v_playlist_wall_id\s+where pi\.playlist_id = v_playlist_id/i)
  assert.match(sql, /order by pi\.position, pi\.id/i)
  assert.match(sql, /v_generation, 0[\s\S]*begin_playlist_transition_locked\(requested_wall_id, v_generation/i)
  assert.doesNotMatch(sql, /where\s+item\.playlist_id\s*=\s*playlist_id/i)
  assert.doesNotMatch(sql, /where\s+playlist_id\s*=/i)
  assert.match(sql, /security definer[\s\S]*set search_path = public/i)
  assert.match(sql, /revoke all on function public\.start_playlist\(uuid, uuid\) from public, anon[\s\S]*grant execute on function public\.start_playlist\(uuid, uuid\) to authenticated/i)
})

test('generation and sequence guards make due advance, next, pause and readiness race-safe', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20260928150000_playlist_runtime.sql', import.meta.url), 'utf8')
  assert.match(sql, /advance_playlist_if_due[\s\S]*for update/i)
  assert.match(sql, /runtime\.generation <> expected_generation or runtime\.sequence <> expected_sequence/i)
  assert.match(sql, /clock_timestamp\(\) < runtime\.next_transition_at/i)
  assert.match(sql, /next_sequence := runtime\.sequence \+ 1/i)
  assert.match(sql, /report_playlist_ready[\s\S]*on conflict \(wall_id, generation, sequence, device_id\) do update/i)
  assert.match(sql, /runtime\.target_scene_id <> expected_target_scene_id/i)
})

test('pause, resume, next, stop, loop and non-loop semantics remain authoritative', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20260928150000_playlist_runtime.sql', import.meta.url), 'utf8')
  assert.match(sql, /pause_playlist[\s\S]*extract\(epoch from \(runtime\.next_transition_at - clock_timestamp\(\)\)\)/i)
  assert.match(sql, /resume_playlist[\s\S]*coalesce\(paused_remaining_ms, 0\) \* interval '1 millisecond'/i)
  assert.match(sql, /next_playlist_item[\s\S]*remain_paused := runtime\.status = 'PAUSED'/i)
  assert.match(sql, /snapshot ->> 'loop'/i)
  assert.match(sql, /status = 'STOPPED'[\s\S]*next_transition_at = null/i)
  assert.match(sql, /go_live_manual[\s\S]*status = 'STOPPED'[\s\S]*insert into public\.wall_state/i)
})

test('playlist wall-state compatibility permits playlist mode and returns completed runs to manual mode', async () => {
  const initialSql = await readFile(new URL('../supabase/migrations/20260928150000_playlist_runtime.sql', import.meta.url), 'utf8')
  const sql = await readFile(new URL('../supabase/migrations/20260929095000_wall_state_playlist_playback_mode_fix.sql', import.meta.url), 'utf8')
  const constraint = sql.match(/add constraint wall_state_playback_mode_check\s+check \(playback_mode in \(([^)]+)\)\)/i)

  assert.ok(constraint)
  assert.deepEqual([...constraint[1].matchAll(/'([^']+)'/g)].map((match) => match[1]), ['manual', 'cycle', 'disabled', 'playlist'])
  assert.match(initialSql, /begin_playlist_transition_locked[\s\S]*values \(runtime\.wall_id, runtime\.loading_scene_id, 'playlist'/i)
  assert.match(initialSql, /commit_playlist_transition_locked[\s\S]*values \(runtime\.wall_id, runtime\.target_scene_id, 'playlist'/i)
  assert.match(initialSql, /go_live_manual[\s\S]*values \(requested_wall_id, requested_scene_id, 'manual'/i)
  assert.match(sql, /create or replace function public\.stop_playlist[\s\S]*update public\.wall_state\s+set playback_mode = 'manual'\s+where wall_id = requested_wall_id/i)
  assert.match(sql, /create or replace function public\.advance_playlist_if_due[\s\S]*status = 'STOPPED'[\s\S]*update public\.wall_state set playback_mode = 'manual' where wall_id = runtime\.wall_id/i)
})

test('only actively heartbeating players join a fixed transition snapshot', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20260928150000_playlist_runtime.sql', import.meta.url), 'utf8')
  const player = await readFile(new URL('../src/player/Player.tsx', import.meta.url), 'utf8')
  const dashboard = await readFile(new URL('../src/admin/Admin.tsx', import.meta.url), 'utf8')
  assert.match(player, /playlistPollIntervalMs\(runtime\)/)
  assert.match(player, /await client\.rpc\('player_heartbeat'/)
  assert.match(sql, /playlist_transition_participant_window[\s\S]*interval '12 seconds'/i)
  assert.match(sql, /included_in_wall is not false[\s\S]*last_seen_at >= transition_started - public\.playlist_transition_participant_window\(\)/i)
  assert.doesNotMatch(sql, /last_seen_at >= now\(\) - interval '10 minutes'/i)
  assert.match(dashboard, /Date\.now\(\) - lastSeenAt <= 10 \* 60 \* 1000/)
  assert.match(sql, /expected_device_ids = expected_devices[\s\S]*ready_device_ids = '\{\}'[\s\S]*failed_device_ids = '\{\}'/i)
  assert.match(sql, /if cardinality\(expected_devices\) = 0 then[\s\S]*commit_playlist_transition_locked/i)
})

test('synchronized activation arms once, anchors duration, and preserves interruption semantics', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20260930100000_playlist_synchronized_activation.sql', import.meta.url), 'utf8')
  const armBody = sql.slice(sql.indexOf('create or replace function public.arm_playlist_transition_locked'), sql.indexOf('create or replace function public.commit_playlist_transition_locked'))
  const reportBody = sql.slice(sql.indexOf('create or replace function public.report_playlist_ready'), sql.indexOf('create or replace function public.go_live_manual'))
  assert.match(sql, /add column activation_at timestamptz/i)
  assert.match(sql, /check \(phase in \('DISPLAYING', 'PREPARING', 'ARMED'\)\)/i)
  assert.match(armBody, /phase = 'ARMED'.*activation_at = armed_at \+ public\.playlist_activation_lead_time\(\)/is)
  assert.doesNotMatch(armBody, /insert into public\.wall_state/i)
  assert.match(reportBody, /if all_ready then return public\.arm_playlist_transition_locked/i)
  assert.match(sql, /runtime\.phase = 'ARMED'.*public\.commit_playlist_transition_locked/is)
  assert.match(sql, /shared_activation := runtime\.activation_at.*started_at = shared_activation.*next_transition_at = case when pause_after_transition then null else shared_activation \+ make_interval/is)
  assert.match(sql, /degraded = cardinality\(failed\) > 0.*failed_device_ids = failed.*arm_playlist_transition_locked/is)
  assert.match(sql, /runtime\.phase in \('PREPARING', 'ARMED'\).*pause_after_transition = true/is)
  assert.match(sql, /stop_playlist.*activation_at = null/is)
  assert.match(sql, /go_live_manual.*activation_at = null/is)
})

test('corrective loading-overlay migration preserves the current wall scene until activation', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20260930110000_playlist_loading_overlay.sql', import.meta.url), 'utf8')
  const beginBody = sql.slice(sql.indexOf('create or replace function public.begin_playlist_transition_locked'), sql.indexOf('create or replace function public.commit_playlist_transition_locked'))
  const commitBody = sql.slice(sql.indexOf('create or replace function public.commit_playlist_transition_locked'), sql.indexOf('create or replace function public.start_playlist'))
  assert.match(sql, /add column loading_at timestamptz/i)
  assert.match(sql, /playlist_loading_lead_time\(\)[\s\S]*interval '900 milliseconds'/i)
  assert.match(sql, /'loading_at', runtime\.loading_at/i)
  assert.match(beginBody, /loading_at = transition_started \+ public\.playlist_loading_lead_time\(\)/i)
  assert.doesNotMatch(beginBody, /insert into public\.wall_state/i)
  assert.match(commitBody, /shared_activation := runtime\.activation_at/i)
  assert.match(commitBody, /values \(runtime\.wall_id, runtime\.target_scene_id, 'playlist'/i)
  assert.match(commitBody, /started_at = shared_activation[\s\S]*next_transition_at = case when pause_after_transition then null else shared_activation \+ make_interval/is)
  assert.doesNotMatch(commitBody, /loading_at = null|activation_at = null/i)
  assert.match(sql, /create or replace function public\.stop_playlist[\s\S]*loading_at = null,[\s\S]*activation_at = null/i)
  assert.match(sql, /create or replace function public\.go_live_manual[\s\S]*loading_at = null,[\s\S]*activation_at = null/i)
  assert.match(sql, /degraded = cardinality\(failed\) > 0[\s\S]*arm_playlist_transition_locked/is)
})

test('timing-margin migration extends loader and activation lead without changing polling', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20261001090000_playlist_timing_margin.sql', import.meta.url), 'utf8')
  assert.equal(PLAYLIST_LOADING_LEAD_MS, 1_500)
  assert.equal(PLAYLIST_ACTIVATION_LEAD_MS, 2_000)
  assert.match(sql, /playlist_loading_lead_time\(\)[\s\S]*interval '1500 milliseconds'/i)
  assert.match(sql, /playlist_activation_lead_time\(\)[\s\S]*interval '2000 milliseconds'/i)
  assert.equal(playlistPollIntervalMs(runtime), 4_000)
  assert.equal(playlistPollIntervalMs({ ...runtime, phase: 'PREPARING' }), 400)
  assert.equal(playlistPollIntervalMs({ ...runtime, phase: 'ARMED' }), 400)
})

test('players use transition-only fast polling and deterministic activation helpers', () => {
  const armed = { ...runtime, phase: 'ARMED', activation_at: '2026-09-28T10:00:01.500Z' }
  assert.equal(playlistPollIntervalMs(runtime), 4000)
  assert.equal(playlistPollIntervalMs({ ...runtime, phase: 'PREPARING' }), 400)
  assert.equal(playlistPollIntervalMs(armed), 400)
  assert.equal(playlistActivationRemainingMs(armed, Date.parse('2026-09-28T10:00:00.300Z')), 1200)
  assert.equal(playlistActivationRemainingMs(armed, Date.parse('2026-09-28T10:00:02Z')), 0)
  assert.equal(formatPlaylistActivationRemaining(1200), '00:01.2')
  assert.equal(playlistRuntimeLabel(armed), 'ARMED')
})

test('loading overlay uses shared timestamps while ordinary scene activation has no crossfade', async () => {
  const helper = await readFile(new URL('../src/lib/playlistRuntime.ts', import.meta.url), 'utf8')
  const player = await readFile(new URL('../src/player/Player.tsx', import.meta.url), 'utf8')
  const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8')
  assert.match(helper, /preload = 'auto'/)
  assert.match(helper, /loadeddata/)
  assert.match(helper, /readyState >= HTMLMediaElement\.HAVE_CURRENT_DATA/)
  assert.doesNotMatch(helper, /video\.play\(/)
  assert.match(player, /activationAt - \(performance\.now\(\) \+ serverEpochOffsetRef\.current\)/)
  assert.match(player, /setScene\(playlistTargetScene\)/)
  assert.match(player, /function PlaylistLoadingOverlay/)
  assert.match(player, /className="playlist-loading-overlay"/)
  assert.doesNotMatch(player, /PlayerSceneSurface/)
  assert.doesNotMatch(styles, /playlist-scene-fade|@keyframes playlist-scene/i)
  assert.match(styles, /\.playlist-loading-overlay[\s\S]*will-change: opacity/i)
})

test('loading overlay timing is deterministic for normal, late, and reduced-motion players', () => {
  const loadingAt = '2026-09-28T10:00:01.000Z'
  const activationAt = '2026-09-28T10:00:03.000Z'
  const preparing = { ...runtime, phase: 'PREPARING', loading_scene_id: 'loader', loading_at: loadingAt }
  const armed = { ...preparing, phase: 'ARMED', activation_at: activationAt }
  const displaying = { ...armed, phase: 'DISPLAYING', current_scene_id: 'target' }

  assert.deepEqual(playlistLoadingOverlayState(preparing, Date.parse('2026-09-28T10:00:00.500Z')), { phase: 'WAITING', mounted: true, opacity: 0, nextAtMs: Date.parse(loadingAt), animate: false })
  assert.equal(playlistLoadingOverlayState(preparing, Date.parse(loadingAt)).phase, 'FADING_IN')
  assert.equal(playlistLoadingOverlayState(preparing, Date.parse('2026-09-28T10:00:01.175Z')).opacity, 0.5)
  assert.deepEqual(playlistLoadingOverlayState(preparing, Date.parse('2026-09-28T10:00:01.350Z')), { phase: 'VISIBLE', mounted: true, opacity: 1, nextAtMs: null, animate: false })
  assert.equal(playlistLoadingOverlayState(armed, Date.parse('2026-09-28T10:00:02.999Z')).phase, 'VISIBLE')
  assert.equal(playlistLoadingOverlayState(armed, Date.parse(activationAt)).opacity, 1)
  assert.equal(playlistLoadingOverlayState(displaying, Date.parse('2026-09-28T10:00:03.175Z')).opacity, 0.5)
  assert.deepEqual(playlistLoadingOverlayState(displaying, Date.parse('2026-09-28T10:00:03.350Z')), { phase: 'HIDDEN', mounted: false, opacity: 0, nextAtMs: null, animate: false })
  assert.deepEqual(playlistLoadingOverlayState(displaying, Date.parse('2026-09-28T10:00:10.000Z')), { phase: 'HIDDEN', mounted: false, opacity: 0, nextAtMs: null, animate: false })
  assert.equal(playlistLoadingOverlayState(armed, Date.parse('2026-09-28T10:00:02.000Z'), true).phase, 'VISIBLE')
  assert.equal(playlistLoadingOverlayState(displaying, Date.parse(activationAt), true).phase, 'HIDDEN')
})

test('presentation skew compares calibrated server-time timestamps safely', () => {
  assert.equal(playlistPresentationSkewMs(1_523, 1_500), 23)
  assert.equal(playlistPresentationSkewMs(1_492, 1_500), -8)
  assert.equal(playlistPresentationSkewMs(Number.NaN, 1_500), null)
  assert.equal(playlistPresentationSkewMs(1_500, Number.NaN), null)
})

test('loading, expected-player readiness, timeout degradation and catch-up are encoded', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20260928150000_playlist_runtime.sql', import.meta.url), 'utf8')
  assert.match(sql, /loading_scene_id is not null and runtime\.loading_scene_id <> runtime\.target_scene_id/i)
  assert.match(sql, /transition_started \+ interval '15 seconds'/i)
  assert.match(sql, /failed_device_ids = failed/i)
  assert.match(sql, /expected_device_ids <@ runtime\.ready_device_ids/i)
  assert.match(sql, /'playlist_runtime', runtime_json[\s\S]*'target_scene'[\s\S]*'loading_scene'/i)
})

test('security grants admin controls and only token-validated player RPCs to anon', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20260928150000_playlist_runtime.sql', import.meta.url), 'utf8')
  assert.match(sql, /grant execute on function public\.start_playlist\(uuid, uuid\) to authenticated/i)
  assert.match(sql, /grant execute on function public\.get_playlist_runtime\(uuid\) to authenticated/i)
  assert.doesNotMatch(sql, /grant execute on function public\.start_playlist\(uuid, uuid\) to anon/i)
  assert.match(sql, /advance_playlist_if_due[\s\S]*player_token = requested_token/i)
  assert.match(sql, /report_playlist_ready[\s\S]*player_token = requested_token/i)
  assert.match(sql, /grant execute on function public\.advance_playlist_if_due[\s\S]*to anon, authenticated/i)
})
