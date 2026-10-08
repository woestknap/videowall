-- MANUAL-01: independently stage a selected manual scene before committing it
-- to wall_state. Playlist runtime remains dedicated to playlists.

create table public.manual_scene_runtime (
  wall_id uuid primary key references public.walls(id) on delete cascade,
  generation uuid not null,
  target_scene_id uuid not null references public.scenes(id) on delete cascade,
  status text not null check (status in ('PREPARING', 'READY', 'ARMED')),
  expected_device_ids uuid[] not null default '{}',
  ready_device_ids uuid[] not null default '{}',
  failed_device_ids uuid[] not null default '{}',
  activation_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.manual_scene_runtime enable row level security;
create policy "authenticated users can read manual scene runtime"
  on public.manual_scene_runtime for select to authenticated using (true);

create or replace function public.manual_scene_runtime_payload(runtime public.manual_scene_runtime)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'wall_id', runtime.wall_id,
    'generation', runtime.generation,
    'target_scene_id', runtime.target_scene_id,
    'status', runtime.status,
    'expected_device_ids', to_jsonb(runtime.expected_device_ids),
    'ready_device_ids', to_jsonb(runtime.ready_device_ids),
    'failed_device_ids', to_jsonb(runtime.failed_device_ids),
    'expected_count', cardinality(runtime.expected_device_ids),
    'ready_count', cardinality(runtime.ready_device_ids),
    'activation_at', runtime.activation_at,
    'created_at', runtime.created_at,
    'updated_at', runtime.updated_at
  )
$$;

create or replace function public.get_manual_scene_runtime(requested_wall_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare runtime public.manual_scene_runtime;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  select * into runtime from public.manual_scene_runtime where wall_id = requested_wall_id;
  return case when runtime.wall_id is null then null else public.manual_scene_runtime_payload(runtime) end;
end;
$$;

create or replace function public.begin_manual_scene_preparation(requested_wall_id uuid, requested_scene_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare scene public.scenes; live_scene_id uuid; expected_devices uuid[]; started_at timestamptz := clock_timestamp(); runtime public.manual_scene_runtime;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  select * into scene from public.scenes where id = requested_scene_id and wall_id = requested_wall_id;
  if scene.id is null then raise exception 'Scene does not belong to this wall' using errcode = '23514'; end if;
  select ws.active_scene_id into live_scene_id from public.wall_state ws where ws.wall_id = requested_wall_id;
  if live_scene_id = requested_scene_id then
    delete from public.manual_scene_runtime where wall_id = requested_wall_id;
    return null;
  end if;
  select coalesce(array_agg(d.id order by d.id), '{}'::uuid[]) into expected_devices
  from public.devices d
  where d.wall_id = requested_wall_id
    and d.included_in_wall is not false
    and d.last_seen_at >= started_at - public.playlist_transition_participant_window();
  insert into public.manual_scene_runtime(
    wall_id, generation, target_scene_id, status, expected_device_ids, ready_device_ids, failed_device_ids, activation_at, created_at, updated_at
  ) values (
    requested_wall_id, gen_random_uuid(), requested_scene_id,
    case when cardinality(expected_devices) = 0 then 'READY' else 'PREPARING' end,
    expected_devices, '{}', '{}', null, started_at, started_at
  ) on conflict (wall_id) do update set
    generation = excluded.generation, target_scene_id = excluded.target_scene_id,
    status = excluded.status, expected_device_ids = excluded.expected_device_ids,
    ready_device_ids = '{}', failed_device_ids = '{}', activation_at = null,
    created_at = excluded.created_at, updated_at = excluded.updated_at
  returning * into runtime;
  return public.manual_scene_runtime_payload(runtime);
end;
$$;

create or replace function public.report_manual_scene_ready(
  requested_device_id uuid, requested_token uuid, expected_generation uuid,
  expected_target_scene_id uuid, readiness_state text default 'READY'
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare device public.devices; runtime public.manual_scene_runtime; all_ready boolean;
begin
  select * into device from public.devices where id = requested_device_id and player_token = requested_token;
  if device.id is null then raise exception 'Unknown player'; end if;
  select * into runtime from public.manual_scene_runtime where wall_id = device.wall_id for update;
  if runtime.wall_id is null or runtime.status <> 'PREPARING' or runtime.generation <> expected_generation
    or runtime.target_scene_id <> expected_target_scene_id or not (device.id = any(runtime.expected_device_ids)) then
    return case when runtime.wall_id is null then null else public.manual_scene_runtime_payload(runtime) end;
  end if;
  if readiness_state = 'READY' then
    if not (device.id = any(runtime.ready_device_ids)) then
      update public.manual_scene_runtime set ready_device_ids = array_append(ready_device_ids, device.id), updated_at = clock_timestamp()
      where wall_id = runtime.wall_id returning * into runtime;
    end if;
  elsif readiness_state = 'ERROR' then
    if not (device.id = any(runtime.failed_device_ids)) then
      update public.manual_scene_runtime set failed_device_ids = array_append(failed_device_ids, device.id), updated_at = clock_timestamp()
      where wall_id = runtime.wall_id returning * into runtime;
    end if;
  else
    raise exception 'Unsupported readiness state' using errcode = '22023';
  end if;
  all_ready := runtime.expected_device_ids <@ runtime.ready_device_ids;
  if all_ready and runtime.status = 'PREPARING' then
    update public.manual_scene_runtime set status = 'READY', updated_at = clock_timestamp()
    where wall_id = runtime.wall_id returning * into runtime;
  end if;
  return public.manual_scene_runtime_payload(runtime);
end;
$$;

create or replace function public.arm_manual_scene_activation(requested_wall_id uuid, expected_generation uuid, force_activation boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare runtime public.manual_scene_runtime; missing uuid[]; armed_at timestamptz := clock_timestamp(); playlist public.playlist_runtime;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  select * into runtime from public.manual_scene_runtime where wall_id = requested_wall_id for update;
  if runtime.wall_id is null or runtime.generation <> expected_generation then return case when runtime.wall_id is null then null else public.manual_scene_runtime_payload(runtime) end; end if;
  if runtime.status = 'ARMED' then return public.manual_scene_runtime_payload(runtime); end if;
  if runtime.status <> 'READY' and not force_activation then raise exception 'Scene is still preparing' using errcode = '23514'; end if;
  select coalesce(array_agg(id), '{}'::uuid[]) into missing from unnest(runtime.expected_device_ids) id where not (id = any(runtime.ready_device_ids));
  update public.manual_scene_runtime set
    status = 'ARMED', activation_at = armed_at + public.playlist_activation_lead_time(),
    failed_device_ids = case when force_activation then missing else failed_device_ids end,
    updated_at = armed_at
  where wall_id = requested_wall_id returning * into runtime;
  select * into playlist from public.playlist_runtime where wall_id = requested_wall_id for update;
  if playlist.wall_id is not null then
    update public.playlist_runtime set status = 'STOPPED', phase = 'DISPLAYING', generation = gen_random_uuid(), sequence = sequence + 1,
      target_index = null, target_item_id = null, target_scene_id = null, next_transition_at = null,
      transition_deadline_at = null, loading_at = null, activation_at = null,
      expected_device_ids = '{}', ready_device_ids = '{}', pause_after_transition = false, updated_at = armed_at
    where wall_id = requested_wall_id;
  end if;
  return public.manual_scene_runtime_payload(runtime);
end;
$$;

create or replace function public.advance_manual_scene_if_due(requested_device_id uuid, requested_token uuid, expected_generation uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare device public.devices; runtime public.manual_scene_runtime;
begin
  select * into device from public.devices where id = requested_device_id and player_token = requested_token;
  if device.id is null then raise exception 'Unknown player'; end if;
  select * into runtime from public.manual_scene_runtime where wall_id = device.wall_id for update;
  if runtime.wall_id is null or runtime.generation <> expected_generation then return case when runtime.wall_id is null then null else public.manual_scene_runtime_payload(runtime) end; end if;
  if runtime.status <> 'ARMED' or runtime.activation_at is null or clock_timestamp() < runtime.activation_at then return public.manual_scene_runtime_payload(runtime); end if;
  insert into public.wall_state(wall_id, active_scene_id, playback_mode, changed_at)
  values (runtime.wall_id, runtime.target_scene_id, 'manual', runtime.activation_at)
  on conflict (wall_id) do update set active_scene_id = excluded.active_scene_id, playback_mode = excluded.playback_mode, changed_at = excluded.changed_at;
  delete from public.manual_scene_runtime where wall_id = runtime.wall_id;
  return jsonb_build_object('applied', true, 'active_scene_id', runtime.target_scene_id, 'changed_at', runtime.activation_at);
end;
$$;

create or replace function public.cancel_manual_scene_preparation(requested_wall_id uuid, expected_generation uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare runtime public.manual_scene_runtime;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  select * into runtime from public.manual_scene_runtime where wall_id = requested_wall_id for update;
  if runtime.wall_id is null or (expected_generation is not null and runtime.generation <> expected_generation) then return null; end if;
  delete from public.manual_scene_runtime where wall_id = requested_wall_id;
  return jsonb_build_object('cancelled', true);
end;
$$;

-- A playlist start is authoritative: any selected manual candidate becomes stale.
create or replace function public.clear_manual_scene_runtime_for_playlist()
returns trigger language plpgsql set search_path = public as $$
begin
  if NEW.status = 'PLAYING' and (TG_OP = 'INSERT' or NEW.generation is distinct from OLD.generation) then
    delete from public.manual_scene_runtime where wall_id = NEW.wall_id;
  end if;
  return NEW;
end;
$$;
create trigger clear_manual_scene_runtime_for_playlist_start
before insert or update on public.playlist_runtime
for each row execute function public.clear_manual_scene_runtime_for_playlist();

-- Immediate/manual callers remain safe and also invalidate an older staged run.
create or replace function public.go_live_manual(requested_wall_id uuid, requested_scene_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare scene public.scenes; runtime public.playlist_runtime; changed timestamptz := clock_timestamp();
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  select * into scene from public.scenes where id = requested_scene_id and wall_id = requested_wall_id;
  if scene.id is null then raise exception 'Scene does not belong to this wall' using errcode = '23514'; end if;
  delete from public.manual_scene_runtime where wall_id = requested_wall_id;
  select * into runtime from public.playlist_runtime where wall_id = requested_wall_id for update;
  if runtime.wall_id is not null then update public.playlist_runtime set status = 'STOPPED', phase = 'DISPLAYING', generation = gen_random_uuid(), sequence = sequence + 1, current_scene_id = requested_scene_id, target_index = null, target_item_id = null, target_scene_id = null, next_transition_at = null, transition_deadline_at = null, loading_at = null, activation_at = null, expected_device_ids = '{}', ready_device_ids = '{}', pause_after_transition = false, updated_at = changed where wall_id = requested_wall_id; end if;
  insert into public.wall_state(wall_id, active_scene_id, playback_mode, changed_at) values (requested_wall_id, requested_scene_id, 'manual', changed)
  on conflict (wall_id) do update set active_scene_id = excluded.active_scene_id, playback_mode = excluded.playback_mode, changed_at = excluded.changed_at;
  return jsonb_build_object('active_scene_id', requested_scene_id, 'changed_at', changed);
end;
$$;

create or replace function public.get_player_state(requested_device_id uuid, requested_token uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare device public.devices; current_scene public.scenes; target_scene public.scenes; loading_scene public.scenes; manual_target_scene public.scenes; wall_devices jsonb; scene_changed_at timestamptz; live_leases jsonb; runtime public.playlist_runtime; manual_runtime public.manual_scene_runtime; runtime_json jsonb; manual_runtime_json jsonb;
begin
  select * into device from public.devices where id = requested_device_id and player_token = requested_token;
  if device.id is null then raise exception 'Unknown player'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'wall_id', wall_id, 'last_seen_at', last_seen_at, 'included_in_wall', included_in_wall, 'layout_x', layout_x, 'layout_y', layout_y, 'layout_width', layout_width, 'layout_height', layout_height) order by layout_y, layout_x), '[]'::jsonb) into wall_devices from public.devices where wall_id = device.wall_id;
  select s.* into current_scene from public.wall_state ws join public.scenes s on s.id = ws.active_scene_id where ws.wall_id = device.wall_id;
  select changed_at into scene_changed_at from public.wall_state where wall_id = device.wall_id;
  select * into runtime from public.playlist_runtime where wall_id = device.wall_id;
  if runtime.wall_id is not null then
    runtime_json := public.playlist_runtime_payload(runtime);
    if runtime.target_scene_id is not null then select * into target_scene from public.scenes where id = runtime.target_scene_id; end if;
    if runtime.loading_scene_id is not null then select * into loading_scene from public.scenes where id = runtime.loading_scene_id; end if;
  end if;
  select * into manual_runtime from public.manual_scene_runtime where wall_id = device.wall_id;
  if manual_runtime.wall_id is not null then
    manual_runtime_json := public.manual_scene_runtime_payload(manual_runtime);
    select * into manual_target_scene from public.scenes where id = manual_runtime.target_scene_id;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('sessionId', session_id, 'liveSourceId', live_source_id, 'targetDeviceId', target_device_id, 'expiresAt', expires_at, 'signalingUrl', signaling_url) order by expires_at desc), '[]'::jsonb) into live_leases from public.live_session_leases where target_device_id = device.id and wall_id = device.wall_id and expires_at > now();
  return jsonb_build_object(
    'server_now', clock_timestamp(), 'devices', wall_devices,
    'virtual_wall_geometry', public.current_virtual_wall_geometry(device.wall_id),
    'scene_started_at', scene_changed_at, 'live_sessions', live_leases,
    'live_session', coalesce(live_leases -> 0, 'null'::jsonb),
    'playlist_runtime', runtime_json,
    'target_scene', case when target_scene.id is null then null else to_jsonb(target_scene) end,
    'loading_scene', case when loading_scene.id is null then null else to_jsonb(loading_scene) end,
    'manual_scene_runtime', manual_runtime_json,
    'manual_target_scene', case when manual_target_scene.id is null then null else to_jsonb(manual_target_scene) end,
    'scene', case when current_scene.id is null then null else to_jsonb(current_scene) end
  );
end;
$$;

revoke all on function public.manual_scene_runtime_payload(public.manual_scene_runtime) from public, anon, authenticated;
revoke all on function public.get_manual_scene_runtime(uuid) from public, anon;
revoke all on function public.begin_manual_scene_preparation(uuid, uuid) from public, anon;
revoke all on function public.arm_manual_scene_activation(uuid, uuid, boolean) from public, anon;
revoke all on function public.cancel_manual_scene_preparation(uuid, uuid) from public, anon;
revoke all on function public.report_manual_scene_ready(uuid, uuid, uuid, uuid, text) from public;
revoke all on function public.advance_manual_scene_if_due(uuid, uuid, uuid) from public;
grant execute on function public.get_manual_scene_runtime(uuid) to authenticated;
grant execute on function public.begin_manual_scene_preparation(uuid, uuid) to authenticated;
grant execute on function public.arm_manual_scene_activation(uuid, uuid, boolean) to authenticated;
grant execute on function public.cancel_manual_scene_preparation(uuid, uuid) to authenticated;
grant execute on function public.report_manual_scene_ready(uuid, uuid, uuid, uuid, text) to anon, authenticated;
grant execute on function public.advance_manual_scene_if_due(uuid, uuid, uuid) to anon, authenticated;
grant execute on function public.get_player_state(uuid, uuid) to anon, authenticated;
