-- PLAYLIST-04: arm prepared transitions with one server-time activation so
-- participating players can reveal the prepared scene together.

alter table public.playlist_runtime
  add column activation_at timestamptz;

alter table public.playlist_runtime
  drop constraint if exists playlist_runtime_phase_check;

alter table public.playlist_runtime
  add constraint playlist_runtime_phase_check
  check (phase in ('DISPLAYING', 'PREPARING', 'ARMED'));

create or replace function public.playlist_activation_lead_time()
returns interval
language sql
immutable
set search_path = public
as $$ select interval '1500 milliseconds' $$;

create or replace function public.playlist_runtime_payload(runtime public.playlist_runtime)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'wall_id', runtime.wall_id,
    'playlist_id', runtime.playlist_id,
    'playlist_name', runtime.playlist_name,
    'status', runtime.status,
    'phase', runtime.phase,
    'generation', runtime.generation,
    'sequence', runtime.sequence,
    'current_index', runtime.current_index,
    'item_count', jsonb_array_length(runtime.snapshot -> 'items'),
    'current_item_id', runtime.current_item_id,
    'current_scene_id', runtime.current_scene_id,
    'current_scene_name', case when runtime.current_index >= 0 then runtime.snapshot -> 'items' -> runtime.current_index ->> 'scene_name' else null end,
    'target_index', runtime.target_index,
    'target_item_id', runtime.target_item_id,
    'target_scene_id', runtime.target_scene_id,
    'target_scene_name', runtime.snapshot -> 'items' -> runtime.target_index ->> 'scene_name',
    'loading_scene_id', runtime.loading_scene_id,
    'started_at', runtime.started_at,
    'next_transition_at', runtime.next_transition_at,
    'paused_remaining_ms', runtime.paused_remaining_ms,
    'transition_deadline_at', runtime.transition_deadline_at,
    'activation_at', runtime.activation_at,
    'expected_count', cardinality(runtime.expected_device_ids),
    'ready_count', cardinality(runtime.ready_device_ids),
    'failed_device_ids', to_jsonb(runtime.failed_device_ids),
    'degraded', runtime.degraded,
    'updated_at', runtime.updated_at
  );
$$;

create or replace function public.arm_playlist_transition_locked(
  requested_wall_id uuid,
  expected_generation uuid,
  expected_sequence bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  runtime public.playlist_runtime;
  armed_at timestamptz := clock_timestamp();
begin
  select * into runtime from public.playlist_runtime
  where wall_id = requested_wall_id for update;
  if runtime.wall_id is null or runtime.generation <> expected_generation
    or runtime.sequence <> expected_sequence or runtime.phase <> 'PREPARING' then
    return case when runtime.wall_id is null then null else public.playlist_runtime_payload(runtime) end;
  end if;

  update public.playlist_runtime set
    phase = 'ARMED',
    activation_at = armed_at + public.playlist_activation_lead_time(),
    transition_deadline_at = null,
    updated_at = armed_at
  where wall_id = runtime.wall_id
  returning * into runtime;
  return public.playlist_runtime_payload(runtime) || jsonb_build_object('applied', true);
end;
$$;

create or replace function public.commit_playlist_transition_locked(
  requested_wall_id uuid,
  expected_generation uuid,
  expected_sequence bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  runtime public.playlist_runtime;
  item jsonb;
  duration_seconds integer;
  shared_activation timestamptz;
begin
  select * into runtime from public.playlist_runtime
  where wall_id = requested_wall_id for update;
  if runtime.wall_id is null or runtime.generation <> expected_generation
    or runtime.sequence <> expected_sequence or runtime.phase <> 'ARMED'
    or runtime.activation_at is null or clock_timestamp() < runtime.activation_at then
    return case when runtime.wall_id is null then null else public.playlist_runtime_payload(runtime) end;
  end if;

  item := runtime.snapshot -> 'items' -> runtime.target_index;
  duration_seconds := (item ->> 'duration_seconds')::integer;
  shared_activation := runtime.activation_at;

  insert into public.wall_state(wall_id, active_scene_id, playback_mode, changed_at)
  values (runtime.wall_id, runtime.target_scene_id, 'playlist', shared_activation)
  on conflict (wall_id) do update set
    active_scene_id = excluded.active_scene_id,
    playback_mode = excluded.playback_mode,
    changed_at = excluded.changed_at;

  update public.playlist_runtime set
    current_index = target_index,
    current_item_id = target_item_id,
    current_scene_id = target_scene_id,
    target_index = null,
    target_item_id = null,
    target_scene_id = null,
    phase = 'DISPLAYING',
    status = case when pause_after_transition then 'PAUSED' else 'PLAYING' end,
    started_at = shared_activation,
    next_transition_at = case when pause_after_transition then null else shared_activation + make_interval(secs => duration_seconds) end,
    paused_remaining_ms = case when pause_after_transition then duration_seconds::bigint * 1000 else null end,
    transition_deadline_at = null,
    activation_at = null,
    pause_after_transition = false,
    updated_at = clock_timestamp()
  where wall_id = runtime.wall_id
  returning * into runtime;
  return public.playlist_runtime_payload(runtime) || jsonb_build_object('applied', true);
end;
$$;

create or replace function public.begin_playlist_transition_locked(
  requested_wall_id uuid,
  expected_generation uuid,
  expected_sequence bigint,
  requested_target_index integer,
  remain_paused boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  runtime public.playlist_runtime;
  item jsonb;
  expected_devices uuid[];
  next_sequence bigint;
  transition_started timestamptz := clock_timestamp();
begin
  select * into runtime from public.playlist_runtime
  where wall_id = requested_wall_id for update;
  if runtime.wall_id is null or runtime.generation <> expected_generation or runtime.sequence <> expected_sequence then
    return case when runtime.wall_id is null then null else public.playlist_runtime_payload(runtime) end;
  end if;
  item := runtime.snapshot -> 'items' -> requested_target_index;
  if item is null then raise exception 'Playlist target item is unavailable' using errcode = '23514'; end if;

  select coalesce(array_agg(d.id order by d.id), '{}'::uuid[]) into expected_devices
  from public.devices d
  where d.wall_id = requested_wall_id
    and d.included_in_wall is not false
    and d.last_seen_at >= transition_started - public.playlist_transition_participant_window();

  next_sequence := runtime.sequence + 1;
  delete from public.playlist_runtime_readiness pr where pr.wall_id = requested_wall_id;
  update public.playlist_runtime set
    sequence = next_sequence,
    status = case when remain_paused then 'PAUSED' else 'PLAYING' end,
    phase = 'PREPARING',
    target_index = requested_target_index,
    target_item_id = (item ->> 'item_id')::uuid,
    target_scene_id = (item ->> 'scene_id')::uuid,
    next_transition_at = null,
    paused_remaining_ms = null,
    transition_deadline_at = transition_started + interval '15 seconds',
    activation_at = null,
    expected_device_ids = expected_devices,
    ready_device_ids = '{}',
    failed_device_ids = '{}',
    degraded = false,
    pause_after_transition = remain_paused,
    updated_at = transition_started
  where wall_id = requested_wall_id
  returning * into runtime;

  if runtime.loading_scene_id is not null and runtime.loading_scene_id <> runtime.target_scene_id then
    insert into public.wall_state(wall_id, active_scene_id, playback_mode, changed_at)
    values (runtime.wall_id, runtime.loading_scene_id, 'playlist', transition_started)
    on conflict (wall_id) do update set active_scene_id = excluded.active_scene_id, playback_mode = excluded.playback_mode, changed_at = excluded.changed_at;
  end if;

  if cardinality(expected_devices) = 0 then
    return public.arm_playlist_transition_locked(requested_wall_id, expected_generation, next_sequence);
  end if;
  return public.playlist_runtime_payload(runtime) || jsonb_build_object('applied', true);
end;
$$;

create or replace function public.start_playlist(requested_wall_id uuid, requested_playlist_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_playlist_id uuid;
  v_playlist_wall_id uuid;
  v_playlist_name text;
  v_playlist_loop boolean;
  v_playlist_loading_scene_id uuid;
  v_snapshot jsonb;
  v_generation uuid := gen_random_uuid();
  v_runtime public.playlist_runtime;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  select p.id, p.wall_id, p.name, p.loop, p.loading_scene_id
  into v_playlist_id, v_playlist_wall_id, v_playlist_name, v_playlist_loop, v_playlist_loading_scene_id
  from public.playlists p
  where p.id = requested_playlist_id and p.wall_id = requested_wall_id
  for share;
  if v_playlist_id is null then raise exception 'Playlist does not belong to this wall' using errcode = '23514'; end if;

  select jsonb_build_object(
    'loop', v_playlist_loop,
    'loading_scene_id', v_playlist_loading_scene_id,
    'items', coalesce(jsonb_agg(jsonb_build_object(
      'item_id', pi.id, 'scene_id', pi.scene_id, 'scene_name', s.name,
      'duration_seconds', pi.duration_seconds, 'position', pi.position
    ) order by pi.position, pi.id), '[]'::jsonb)
  ) into v_snapshot
  from public.playlist_items pi
  join public.scenes s on s.id = pi.scene_id and s.wall_id = v_playlist_wall_id
  where pi.playlist_id = v_playlist_id;
  if jsonb_array_length(v_snapshot -> 'items') = 0 then raise exception 'Playlist must contain at least one valid item' using errcode = '23514'; end if;

  insert into public.playlist_runtime(
    wall_id, playlist_id, playlist_name, status, phase, generation, sequence,
    snapshot, current_index, loading_scene_id, activation_at, updated_at
  ) values (
    requested_wall_id, v_playlist_id, v_playlist_name, 'PLAYING', 'DISPLAYING', v_generation, 0,
    v_snapshot, -1, v_playlist_loading_scene_id, null, clock_timestamp()
  ) on conflict (wall_id) do update set
    playlist_id = excluded.playlist_id, playlist_name = excluded.playlist_name,
    status = excluded.status, phase = excluded.phase, generation = excluded.generation,
    sequence = 0, snapshot = excluded.snapshot, current_index = -1,
    current_item_id = null, current_scene_id = null, target_index = null,
    target_item_id = null, target_scene_id = null, loading_scene_id = excluded.loading_scene_id,
    started_at = null, next_transition_at = null, paused_remaining_ms = null,
    transition_deadline_at = null, activation_at = null,
    expected_device_ids = '{}', ready_device_ids = '{}', failed_device_ids = '{}',
    degraded = false, pause_after_transition = false, updated_at = excluded.updated_at
  returning * into v_runtime;
  return public.begin_playlist_transition_locked(requested_wall_id, v_generation, 0, 0, false);
end;
$$;

create or replace function public.pause_playlist(requested_wall_id uuid, expected_generation uuid, expected_sequence bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare runtime public.playlist_runtime; remaining bigint;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  select * into runtime from public.playlist_runtime where wall_id = requested_wall_id for update;
  if runtime.generation <> expected_generation or runtime.sequence <> expected_sequence or runtime.status <> 'PLAYING' then return public.playlist_runtime_payload(runtime); end if;
  if runtime.phase in ('PREPARING', 'ARMED') then
    update public.playlist_runtime set status = 'PAUSED', pause_after_transition = true, sequence = sequence + 1, updated_at = clock_timestamp() where wall_id = requested_wall_id returning * into runtime;
  else
    remaining := greatest(0, floor(extract(epoch from (runtime.next_transition_at - clock_timestamp())) * 1000)::bigint);
    update public.playlist_runtime set status = 'PAUSED', sequence = sequence + 1, paused_remaining_ms = remaining, next_transition_at = null, updated_at = clock_timestamp() where wall_id = requested_wall_id returning * into runtime;
  end if;
  return public.playlist_runtime_payload(runtime) || jsonb_build_object('applied', true);
end; $$;

create or replace function public.resume_playlist(requested_wall_id uuid, expected_generation uuid, expected_sequence bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare runtime public.playlist_runtime; resumed_at timestamptz := clock_timestamp();
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  select * into runtime from public.playlist_runtime where wall_id = requested_wall_id for update;
  if runtime.generation <> expected_generation or runtime.sequence <> expected_sequence or runtime.status <> 'PAUSED' then return public.playlist_runtime_payload(runtime); end if;
  if runtime.phase in ('PREPARING', 'ARMED') then
    update public.playlist_runtime set status = 'PLAYING', pause_after_transition = false, sequence = sequence + 1, updated_at = resumed_at where wall_id = requested_wall_id returning * into runtime;
  else
    update public.playlist_runtime set status = 'PLAYING', sequence = sequence + 1, next_transition_at = resumed_at + (coalesce(paused_remaining_ms, 0) * interval '1 millisecond'), paused_remaining_ms = null, updated_at = resumed_at where wall_id = requested_wall_id returning * into runtime;
  end if;
  return public.playlist_runtime_payload(runtime) || jsonb_build_object('applied', true);
end; $$;

create or replace function public.stop_playlist(requested_wall_id uuid, expected_generation uuid default null, expected_sequence bigint default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare runtime public.playlist_runtime;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  select * into runtime from public.playlist_runtime where wall_id = requested_wall_id for update;
  if runtime.wall_id is null then return null; end if;
  if expected_generation is not null and (runtime.generation <> expected_generation or runtime.sequence <> expected_sequence) then return public.playlist_runtime_payload(runtime); end if;
  update public.playlist_runtime set
    status = 'STOPPED', phase = 'DISPLAYING', generation = gen_random_uuid(), sequence = sequence + 1,
    target_index = null, target_item_id = null, target_scene_id = null,
    next_transition_at = null, paused_remaining_ms = null, transition_deadline_at = null, activation_at = null,
    expected_device_ids = '{}', ready_device_ids = '{}', pause_after_transition = false,
    updated_at = clock_timestamp()
  where wall_id = requested_wall_id returning * into runtime;
  update public.wall_state set playback_mode = 'manual' where wall_id = requested_wall_id;
  return public.playlist_runtime_payload(runtime) || jsonb_build_object('applied', true);
end; $$;

create or replace function public.advance_playlist_if_due(requested_device_id uuid, requested_token uuid, expected_generation uuid, expected_sequence bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
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
    return public.arm_playlist_transition_locked(runtime.wall_id, runtime.generation, runtime.sequence);
  end if;
  if runtime.phase = 'ARMED' then
    return public.commit_playlist_transition_locked(runtime.wall_id, runtime.generation, runtime.sequence);
  end if;
  if runtime.status <> 'PLAYING' or runtime.next_transition_at is null or clock_timestamp() < runtime.next_transition_at then return public.playlist_runtime_payload(runtime); end if;
  item_count := jsonb_array_length(runtime.snapshot -> 'items'); next_index := runtime.current_index + 1;
  if next_index >= item_count then
    if coalesce((runtime.snapshot ->> 'loop')::boolean, false) then next_index := 0;
    else
      update public.playlist_runtime set status = 'STOPPED', generation = gen_random_uuid(), sequence = sequence + 1, next_transition_at = null, activation_at = null, updated_at = clock_timestamp() where wall_id = runtime.wall_id returning * into runtime;
      update public.wall_state set playback_mode = 'manual' where wall_id = runtime.wall_id;
      return public.playlist_runtime_payload(runtime) || jsonb_build_object('applied', true);
    end if;
  end if;
  return public.begin_playlist_transition_locked(runtime.wall_id, runtime.generation, runtime.sequence, next_index, false);
end; $$;

create or replace function public.report_playlist_ready(requested_device_id uuid, requested_token uuid, expected_generation uuid, expected_sequence bigint, expected_target_scene_id uuid, readiness_state text default 'READY', readiness_detail text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare device public.devices; runtime public.playlist_runtime; all_ready boolean;
begin
  select * into device from public.devices where id = requested_device_id and player_token = requested_token;
  if device.id is null then raise exception 'Unknown player'; end if;
  select * into runtime from public.playlist_runtime where wall_id = device.wall_id for update;
  if runtime.wall_id is null or runtime.generation <> expected_generation or runtime.sequence <> expected_sequence or runtime.phase <> 'PREPARING' or runtime.target_scene_id <> expected_target_scene_id or not (device.id = any(runtime.expected_device_ids)) then return case when runtime.wall_id is null then null else public.playlist_runtime_payload(runtime) end; end if;
  if readiness_state not in ('READY', 'ERROR') then raise exception 'Invalid readiness state' using errcode = '23514'; end if;
  insert into public.playlist_runtime_readiness(wall_id, generation, sequence, device_id, target_scene_id, state, detail)
  values (runtime.wall_id, runtime.generation, runtime.sequence, device.id, runtime.target_scene_id, readiness_state, left(readiness_detail, 300))
  on conflict (wall_id, generation, sequence, device_id) do update set state = excluded.state, detail = excluded.detail, updated_at = now();
  if readiness_state = 'READY' and not (device.id = any(runtime.ready_device_ids)) then
    update public.playlist_runtime set ready_device_ids = array_append(ready_device_ids, device.id), updated_at = clock_timestamp() where wall_id = runtime.wall_id returning * into runtime;
  end if;
  all_ready := runtime.expected_device_ids <@ runtime.ready_device_ids;
  if all_ready then return public.arm_playlist_transition_locked(runtime.wall_id, runtime.generation, runtime.sequence); end if;
  return public.playlist_runtime_payload(runtime) || jsonb_build_object('applied', true);
end; $$;

create or replace function public.go_live_manual(requested_wall_id uuid, requested_scene_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare scene public.scenes; runtime public.playlist_runtime; changed timestamptz := clock_timestamp();
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  select * into scene from public.scenes where id = requested_scene_id and wall_id = requested_wall_id;
  if scene.id is null then raise exception 'Scene does not belong to this wall' using errcode = '23514'; end if;
  select * into runtime from public.playlist_runtime where wall_id = requested_wall_id for update;
  if runtime.wall_id is not null then update public.playlist_runtime set status = 'STOPPED', phase = 'DISPLAYING', generation = gen_random_uuid(), sequence = sequence + 1, current_scene_id = requested_scene_id, target_index = null, target_item_id = null, target_scene_id = null, next_transition_at = null, transition_deadline_at = null, activation_at = null, expected_device_ids = '{}', ready_device_ids = '{}', pause_after_transition = false, updated_at = changed where wall_id = requested_wall_id; end if;
  insert into public.wall_state(wall_id, active_scene_id, playback_mode, changed_at) values (requested_wall_id, requested_scene_id, 'manual', changed)
  on conflict (wall_id) do update set active_scene_id = excluded.active_scene_id, playback_mode = excluded.playback_mode, changed_at = excluded.changed_at;
  return jsonb_build_object('active_scene_id', requested_scene_id, 'changed_at', changed);
end; $$;

revoke all on function public.playlist_activation_lead_time() from public, anon, authenticated;
revoke all on function public.playlist_runtime_payload(public.playlist_runtime) from public, anon, authenticated;
revoke all on function public.arm_playlist_transition_locked(uuid, uuid, bigint) from public, anon, authenticated;
revoke all on function public.commit_playlist_transition_locked(uuid, uuid, bigint) from public, anon, authenticated;
revoke all on function public.begin_playlist_transition_locked(uuid, uuid, bigint, integer, boolean) from public, anon, authenticated;
revoke all on function public.start_playlist(uuid, uuid) from public, anon;
revoke all on function public.pause_playlist(uuid, uuid, bigint) from public, anon;
revoke all on function public.resume_playlist(uuid, uuid, bigint) from public, anon;
revoke all on function public.stop_playlist(uuid, uuid, bigint) from public, anon;
revoke all on function public.go_live_manual(uuid, uuid) from public, anon;
revoke all on function public.advance_playlist_if_due(uuid, uuid, uuid, bigint) from public;
revoke all on function public.report_playlist_ready(uuid, uuid, uuid, bigint, uuid, text, text) from public;
grant execute on function public.start_playlist(uuid, uuid) to authenticated;
grant execute on function public.pause_playlist(uuid, uuid, bigint) to authenticated;
grant execute on function public.resume_playlist(uuid, uuid, bigint) to authenticated;
grant execute on function public.stop_playlist(uuid, uuid, bigint) to authenticated;
grant execute on function public.go_live_manual(uuid, uuid) to authenticated;
grant execute on function public.advance_playlist_if_due(uuid, uuid, uuid, bigint) to anon, authenticated;
grant execute on function public.report_playlist_ready(uuid, uuid, uuid, bigint, uuid, text, text) to anon, authenticated;
