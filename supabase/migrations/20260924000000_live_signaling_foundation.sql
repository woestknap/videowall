-- LIVE-05A: short-lived player discovery only. SDP and ICE never belong here.
create table public.live_session_leases (
  session_id text primary key check (session_id ~ '^[A-Za-z0-9_-]{32,128}$'),
  wall_id uuid not null references public.walls(id) on delete cascade,
  target_device_id uuid not null references public.devices(id) on delete cascade,
  live_source_id uuid not null,
  controller_user_id uuid not null,
  signaling_url text not null check (signaling_url ~ '^wss?://'),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (live_source_id, target_device_id)
);

create index live_session_leases_target_expiry_idx
  on public.live_session_leases(target_device_id, expires_at);

alter table public.live_session_leases enable row level security;
-- No table policies: browsers discover leases only through token-checked RPCs.

create or replace function public.create_live_session_lease(
  requested_session_id text,
  requested_wall_id uuid,
  requested_target_device_id uuid,
  requested_live_source_id uuid,
  requested_controller_user_id uuid,
  requested_signaling_url text,
  requested_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.devices;
  created public.live_session_leases;
begin
  if requested_expires_at <= now() or requested_expires_at > now() + interval '2 minutes' then
    raise exception 'Invalid lease expiry';
  end if;
  if requested_signaling_url !~ '^wss?://' then
    raise exception 'Invalid signaling URL';
  end if;

  select * into target from public.devices
  where id = requested_target_device_id and wall_id = requested_wall_id;
  if target.id is null then raise exception 'Target device is not on the requested wall'; end if;
  if not exists (select 1 from public.walls where id = requested_wall_id) then raise exception 'Unknown wall'; end if;
  if not exists (
    select 1
    from public.scenes scene
    cross join lateral jsonb_array_elements(scene.layers) layer
    where layer->>'type' = 'live'
      and layer->'content'->>'liveSourceId' = requested_live_source_id::text
      and (cardinality(scene.device_ids) = 0 or requested_target_device_id = any(scene.device_ids))
      and (
        jsonb_array_length(coalesce(layer->'target', '[]'::jsonb)) = 0
        or (layer->'target') ? requested_target_device_id::text
      )
  ) then
    raise exception 'Live source does not target this device';
  end if;

  insert into public.live_session_leases(
    session_id, wall_id, target_device_id, live_source_id,
    controller_user_id, signaling_url, expires_at
  ) values (
    requested_session_id, requested_wall_id, requested_target_device_id, requested_live_source_id,
    requested_controller_user_id, requested_signaling_url, requested_expires_at
  )
  on conflict (live_source_id, target_device_id) do update
    set session_id = excluded.session_id,
        wall_id = excluded.wall_id,
        controller_user_id = excluded.controller_user_id,
        signaling_url = excluded.signaling_url,
        expires_at = excluded.expires_at,
        created_at = now()
  returning * into created;

  return jsonb_build_object(
    'session_id', created.session_id,
    'wall_id', created.wall_id,
    'target_device_id', created.target_device_id,
    'live_source_id', created.live_source_id,
    'expires_at', created.expires_at
  );
end;
$$;

create or replace function public.validate_live_player(
  requested_device_id uuid,
  requested_token uuid,
  requested_session_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  device public.devices;
  lease public.live_session_leases;
begin
  select * into device from public.devices
  where id = requested_device_id and player_token = requested_token;
  if device.id is null then raise exception 'Unknown player'; end if;

  select * into lease from public.live_session_leases
  where session_id = requested_session_id
    and target_device_id = device.id
    and wall_id = device.wall_id
    and expires_at > now();
  if lease.session_id is null then raise exception 'Unknown or expired live session'; end if;

  return jsonb_build_object(
    'session_id', lease.session_id,
    'wall_id', lease.wall_id,
    'target_device_id', lease.target_device_id,
    'live_source_id', lease.live_source_id,
    'expires_at', lease.expires_at
  );
end;
$$;

create or replace function public.renew_live_session_lease(
  requested_session_id text,
  requested_controller_user_id uuid,
  requested_expires_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if requested_expires_at <= now() or requested_expires_at > now() + interval '2 minutes' then
    raise exception 'Invalid lease expiry';
  end if;
  update public.live_session_leases
  set expires_at = requested_expires_at
  where session_id = requested_session_id
    and controller_user_id = requested_controller_user_id
    and expires_at > now();
  if not found then raise exception 'Unknown or expired live session'; end if;
end;
$$;

create or replace function public.end_live_session_lease(
  requested_session_id text,
  requested_controller_user_id uuid
)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.live_session_leases
  where session_id = requested_session_id
    and controller_user_id = requested_controller_user_id;
$$;

-- Extend the existing token-protected player poll with one active, device-scoped lease.
create or replace function public.get_player_state(requested_device_id uuid, requested_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  device public.devices;
  current_scene public.scenes;
  wall_devices jsonb;
  scene_changed_at timestamptz;
  live_lease public.live_session_leases;
begin
  select * into device from public.devices
  where id = requested_device_id and player_token = requested_token;
  if device.id is null then raise exception 'Unknown player'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id, 'layout_x', layout_x, 'layout_y', layout_y,
    'layout_width', layout_width, 'layout_height', layout_height
  ) order by layout_y, layout_x), '[]'::jsonb)
  into wall_devices from public.devices where wall_id = device.wall_id;

  select s.* into current_scene from public.wall_state ws
  join public.scenes s on s.id = ws.active_scene_id
  where ws.wall_id = device.wall_id;
  select changed_at into scene_changed_at from public.wall_state where wall_id = device.wall_id;

  select * into live_lease from public.live_session_leases
  where target_device_id = device.id and wall_id = device.wall_id and expires_at > now()
  order by expires_at desc limit 1;

  return jsonb_build_object(
    'server_now', clock_timestamp(),
    'devices', wall_devices,
    'scene_started_at', scene_changed_at,
    'live_session', case when live_lease.session_id is null then null else jsonb_build_object(
      'sessionId', live_lease.session_id,
      'liveSourceId', live_lease.live_source_id,
      'targetDeviceId', live_lease.target_device_id,
      'expiresAt', live_lease.expires_at,
      'signalingUrl', live_lease.signaling_url
    ) end,
    'scene', case when current_scene.id is null then null else jsonb_build_object(
      'id', current_scene.id, 'name', current_scene.name, 'layers', current_scene.layers,
      'duration_seconds', current_scene.duration_seconds, 'device_ids', current_scene.device_ids
    ) end
  );
end;
$$;

revoke all on table public.live_session_leases from anon, authenticated;
revoke execute on function public.create_live_session_lease(text, uuid, uuid, uuid, uuid, text, timestamptz) from public, anon, authenticated;
revoke execute on function public.validate_live_player(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.renew_live_session_lease(text, uuid, timestamptz) from public, anon, authenticated;
revoke execute on function public.end_live_session_lease(text, uuid) from public, anon, authenticated;
grant execute on function public.create_live_session_lease(text, uuid, uuid, uuid, uuid, text, timestamptz) to service_role;
grant execute on function public.validate_live_player(uuid, uuid, text) to service_role;
grant execute on function public.renew_live_session_lease(text, uuid, timestamptz) to service_role;
grant execute on function public.end_live_session_lease(text, uuid) to service_role;
grant execute on function public.get_player_state(uuid, uuid) to anon, authenticated;
