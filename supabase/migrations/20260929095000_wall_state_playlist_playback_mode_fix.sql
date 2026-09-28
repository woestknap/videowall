-- PLAYLIST-03 writes the explicit playlist mode while a runtime owns wall output.
-- The original wall_state constraint predates playlists, so extend it without
-- modifying any already-applied migration.
alter table public.wall_state
  drop constraint if exists wall_state_playback_mode_check;

alter table public.wall_state
  add constraint wall_state_playback_mode_check
  check (playback_mode in ('manual', 'cycle', 'disabled', 'playlist'));

-- Stopping a playlist leaves the current scene visible, but returns ownership of
-- that output to manual control. Keep changed_at intact so this state-only update
-- does not restart the visible scene on players.
create or replace function public.stop_playlist(
  requested_wall_id uuid,
  expected_generation uuid default null,
  expected_sequence bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare runtime public.playlist_runtime;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  select * into runtime from public.playlist_runtime where wall_id = requested_wall_id for update;
  if runtime.wall_id is null then return null; end if;
  if expected_generation is not null and (runtime.generation <> expected_generation or runtime.sequence <> expected_sequence) then return public.playlist_runtime_payload(runtime); end if;

  update public.playlist_runtime set
    status = 'STOPPED', phase = 'DISPLAYING', generation = gen_random_uuid(), sequence = sequence + 1,
    target_index = null, target_item_id = null, target_scene_id = null,
    next_transition_at = null, paused_remaining_ms = null, transition_deadline_at = null,
    expected_device_ids = '{}', ready_device_ids = '{}', pause_after_transition = false,
    updated_at = clock_timestamp()
  where wall_id = requested_wall_id
  returning * into runtime;

  update public.wall_state
  set playback_mode = 'manual'
  where wall_id = requested_wall_id;

  return public.playlist_runtime_payload(runtime) || jsonb_build_object('applied', true);
end;
$$;

-- A non-looping playlist has the same terminal ownership semantics as Stop.
-- It retains its final scene, while no longer reporting playlist control.
create or replace function public.advance_playlist_if_due(
  requested_device_id uuid,
  requested_token uuid,
  expected_generation uuid,
  expected_sequence bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare device public.devices; runtime public.playlist_runtime; next_index integer; item_count integer; failed uuid[];
begin
  select * into device from public.devices where id = requested_device_id and player_token = requested_token;
  if device.id is null then raise exception 'Unknown player'; end if;
  select * into runtime from public.playlist_runtime where wall_id = device.wall_id for update;
  if runtime.wall_id is null or runtime.generation <> expected_generation or runtime.sequence <> expected_sequence then return case when runtime.wall_id is null then null else public.playlist_runtime_payload(runtime) end; end if;
  if runtime.phase = 'PREPARING' then
    if runtime.transition_deadline_at is null or clock_timestamp() < runtime.transition_deadline_at then return public.playlist_runtime_payload(runtime); end if;
    select coalesce(array_agg(id), '{}'::uuid[]) into failed from unnest(runtime.expected_device_ids) id where not (id = any(runtime.ready_device_ids));
    update public.playlist_runtime set degraded = cardinality(failed) > 0, failed_device_ids = failed, updated_at = clock_timestamp() where wall_id = runtime.wall_id;
    return public.commit_playlist_transition_locked(runtime.wall_id, runtime.generation, runtime.sequence);
  end if;
  if runtime.status <> 'PLAYING' or runtime.next_transition_at is null or clock_timestamp() < runtime.next_transition_at then return public.playlist_runtime_payload(runtime); end if;
  item_count := jsonb_array_length(runtime.snapshot -> 'items'); next_index := runtime.current_index + 1;
  if next_index >= item_count then
    if coalesce((runtime.snapshot ->> 'loop')::boolean, false) then next_index := 0;
    else
      update public.playlist_runtime set status = 'STOPPED', generation = gen_random_uuid(), sequence = sequence + 1, next_transition_at = null, updated_at = clock_timestamp() where wall_id = runtime.wall_id returning * into runtime;
      update public.wall_state set playback_mode = 'manual' where wall_id = runtime.wall_id;
      return public.playlist_runtime_payload(runtime) || jsonb_build_object('applied', true);
    end if;
  end if;
  return public.begin_playlist_transition_locked(runtime.wall_id, runtime.generation, runtime.sequence, next_index, false);
end;
$$;

revoke all on function public.stop_playlist(uuid, uuid, bigint) from public, anon;
grant execute on function public.stop_playlist(uuid, uuid, bigint) to authenticated;
revoke all on function public.advance_playlist_if_due(uuid, uuid, uuid, bigint) from public;
grant execute on function public.advance_playlist_if_due(uuid, uuid, uuid, bigint) to anon, authenticated;
