import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { manualSceneActivationRemainingMs, manualSceneIsReadyForActivation, manualScenePollIntervalMs } from '../src/lib/manualSceneRuntime.ts'

const runtime = {
  wall_id: 'wall', generation: 'generation', target_scene_id: 'scene-b', status: 'PREPARING',
  expected_device_ids: ['pi-a', 'pi-b'], ready_device_ids: [], failed_device_ids: [], activation_at: null,
  created_at: '2026-10-08T10:00:00Z', updated_at: '2026-10-08T10:00:00Z',
}

test('manual staging only uses fast polling while a runtime exists', () => {
  assert.equal(manualScenePollIntervalMs(null), 4_000)
  assert.equal(manualScenePollIntervalMs(runtime), 400)
  const armed = { ...runtime, status: 'ARMED', activation_at: '2026-10-08T10:00:02.000Z' }
  assert.equal(manualSceneActivationRemainingMs(armed, Date.parse('2026-10-08T10:00:00.500Z')), 1_500)
  assert.equal(manualSceneActivationRemainingMs(armed, Date.parse('2026-10-08T10:00:03.000Z')), 0)
  assert.equal(manualSceneIsReadyForActivation({ ...runtime, status: 'READY' }, 'scene-b'), true)
  assert.equal(manualSceneIsReadyForActivation({ ...runtime, status: 'PREPARING' }, 'scene-b'), false)
})

test('manual-stage migration keeps preparation separate from wall_state and playlist runtime', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20261008090000_manual_scene_staging.sql', import.meta.url), 'utf8')
  const begin = sql.slice(sql.indexOf('create or replace function public.begin_manual_scene_preparation'), sql.indexOf('create or replace function public.report_manual_scene_ready'))
  const arm = sql.slice(sql.indexOf('create or replace function public.arm_manual_scene_activation'), sql.indexOf('create or replace function public.advance_manual_scene_if_due'))
  const advance = sql.slice(sql.indexOf('create or replace function public.advance_manual_scene_if_due'), sql.indexOf('create or replace function public.cancel_manual_scene_preparation'))
  assert.match(sql, /create table public\.manual_scene_runtime/i)
  assert.match(sql, /status text not null check \(status in \('PREPARING', 'READY', 'ARMED'\)\)/i)
  assert.match(begin, /generation = excluded\.generation[\s\S]*ready_device_ids = '\{\}'[\s\S]*activation_at = null/i)
  assert.match(begin, /playlist_transition_participant_window\(\)/i)
  assert.doesNotMatch(begin, /insert into public\.wall_state/i)
  assert.match(sql, /runtime\.generation <> expected_generation/i)
  assert.match(sql, /all_ready := runtime\.expected_device_ids <@ runtime\.ready_device_ids/i)
  assert.match(sql, /status = 'READY'/i)
  assert.match(arm, /runtime\.status <> 'READY' and not force_activation/i)
  assert.match(arm, /activation_at = armed_at \+ public\.playlist_activation_lead_time\(\)/i)
  assert.match(arm, /failed_device_ids = case when force_activation then missing/i)
  assert.match(arm, /update public\.playlist_runtime set status = 'STOPPED'/i)
  assert.match(advance, /clock_timestamp\(\) < runtime\.activation_at/i)
  assert.match(advance, /values \(runtime\.wall_id, runtime\.target_scene_id, 'manual', runtime\.activation_at\)/i)
  assert.match(sql, /clear_manual_scene_runtime_for_playlist/i)
  assert.match(sql, /delete from public\.manual_scene_runtime where wall_id = NEW\.wall_id/i)
})

test('player prepares manual targets offscreen, reports only current generations, and activates locally without fades', async () => {
  const player = await readFile(new URL('../src/player/Player.tsx', import.meta.url), 'utf8')
  const runtimeHelper = await readFile(new URL('../src/lib/playlistRuntime.ts', import.meta.url), 'utf8')
  assert.match(runtimeHelper, /export async function prepareScene/)
  assert.match(player, /report_manual_scene_ready/)
  assert.match(player, /manualSceneRuntime\.status === 'PREPARING'/)
  assert.match(player, /manualSceneActivationRemainingMs/)
  assert.match(player, /advance_manual_scene_if_due/)
  assert.doesNotMatch(player, /manual.*fade/i)
})

test('dashboard selection begins staging and gates Go live until READY', async () => {
  const admin = await readFile(new URL('../src/admin/Admin.tsx', import.meta.url), 'utf8')
  assert.match(admin, /begin_manual_scene_preparation/)
  assert.match(admin, /arm_manual_scene_activation/)
  assert.match(admin, /cancel_manual_scene_preparation/)
  assert.match(admin, /selectedManualRuntime\.status !== 'READY'/)
  assert.match(admin, /Go live anyway/)
  assert.match(admin, /Preparing \$\{scene\.name\} on active players/)
})
