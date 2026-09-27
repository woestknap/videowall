-- PIXEL-01 adds the versioned persistence contract only. Existing scenes stay
-- on geometry version 1 and retain their percentage layer JSON unchanged.
alter table public.walls
  add column if not exists layout_mode text,
  add column if not exists virtual_pixels_per_mm double precision;

alter table public.walls
  add constraint walls_layout_mode_check
    check (layout_mode is null or layout_mode in ('resolution', 'physical')),
  add constraint walls_physical_calibration_check
    check (layout_mode is distinct from 'physical' or (virtual_pixels_per_mm is not null and virtual_pixels_per_mm > 0));

alter table public.scenes
  add column if not exists wall_id uuid references public.walls(id) on delete set null,
  add column if not exists geometry_version smallint not null default 1,
  add column if not exists canvas_width_px double precision,
  add column if not exists canvas_height_px double precision,
  add column if not exists wall_geometry_revision text;

alter table public.scenes
  add constraint scenes_geometry_version_check check (geometry_version in (1, 2)),
  add constraint scenes_v2_canvas_check check (
    geometry_version = 1 or (
      canvas_width_px is not null and canvas_width_px > 0 and
      canvas_height_px is not null and canvas_height_px > 0 and
      wall_geometry_revision is not null and char_length(wall_geometry_revision) > 0
    )
  );

-- Canonical numbers match the browser contract: six fractional digits at most,
-- no trailing zeroes, and negative zero normalized to zero.
create or replace function public.geometry_number_text(value double precision)
returns text
language plpgsql
immutable
strict
set search_path = public
as $$
declare
  rounded_value numeric;
  rendered text;
begin
  rounded_value := round(value::numeric, 6);
  if rounded_value = 0 then return '0'; end if;
  rendered := trim(trailing '0' from rounded_value::text);
  return trim(trailing '.' from rendered);
end;
$$;

-- Small deterministic FNV-1a fingerprint. This is change detection, not a
-- security primitive. Device viewport resolution is deliberately excluded.
create or replace function public.geometry_fnv1a32(value text)
returns text
language plpgsql
immutable
strict
set search_path = public
as $$
declare
  hash_value bigint := 2166136261;
  bytes bytea := convert_to(value, 'UTF8');
  byte_index integer;
begin
  if octet_length(bytes) > 0 then
    for byte_index in 0..octet_length(bytes) - 1 loop
      hash_value := ((hash_value # get_byte(bytes, byte_index)) * 16777619) % 4294967296;
    end loop;
  end if;
  return lpad(to_hex(hash_value), 8, '0');
end;
$$;

create or replace function public.current_virtual_wall_geometry(requested_wall_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  wall_mode text;
  pixels_per_mm double precision;
  device_count integer;
  units_match boolean;
  invalid_device_count integer;
  minimum_x double precision;
  minimum_y double precision;
  maximum_x double precision;
  maximum_y double precision;
  coordinate_scale double precision;
  canonical_devices text;
  revision text;
  regions jsonb;
begin
  select layout_mode, virtual_pixels_per_mm
  into wall_mode, pixels_per_mm
  from public.walls
  where id = requested_wall_id;

  if wall_mode is null then
    return jsonb_build_object('status', 'invalid', 'reason', 'layout-mode-required');
  end if;

  select count(*),
    case when wall_mode = 'resolution' then bool_and(auto_size) else bool_and(not auto_size) end,
    count(*) filter (where layout_width <= 0 or layout_height <= 0
      or layout_x::text in ('NaN', 'Infinity', '-Infinity')
      or layout_y::text in ('NaN', 'Infinity', '-Infinity')
      or layout_width::text in ('NaN', 'Infinity', '-Infinity')
      or layout_height::text in ('NaN', 'Infinity', '-Infinity'))
  into device_count, units_match, invalid_device_count
  from public.devices
  where wall_id = requested_wall_id;

  if device_count = 0 then
    return jsonb_build_object('status', 'invalid', 'reason', 'no-devices');
  end if;
  if not coalesce(units_match, false) then
    return jsonb_build_object('status', 'invalid', 'reason', 'mixed-layout-units');
  end if;
  if invalid_device_count > 0 then
    return jsonb_build_object('status', 'invalid', 'reason', 'invalid-device-geometry');
  end if;
  if wall_mode = 'physical' and (pixels_per_mm is null or pixels_per_mm <= 0
    or pixels_per_mm::text in ('NaN', 'Infinity', '-Infinity')) then
    return jsonb_build_object('status', 'invalid', 'reason', 'invalid-calibration');
  end if;

  coordinate_scale := case when wall_mode = 'physical' then pixels_per_mm else 1 end;

  select min(layout_x), min(layout_y), max(layout_x + layout_width), max(layout_y + layout_height),
    string_agg(
      id::text || ':' || public.geometry_number_text(layout_x) || ',' || public.geometry_number_text(layout_y) || ',' ||
      public.geometry_number_text(layout_width) || ',' || public.geometry_number_text(layout_height),
      '|' order by id::text
    )
  into minimum_x, minimum_y, maximum_x, maximum_y, canonical_devices
  from public.devices
  where wall_id = requested_wall_id;

  revision := public.geometry_fnv1a32(
    wall_mode || '|' || case when wall_mode = 'physical' then public.geometry_number_text(pixels_per_mm) else '-' end || '|' || canonical_devices
  );

  select jsonb_agg(jsonb_build_object(
    'deviceId', id,
    'xPx', round(((layout_x - minimum_x) * coordinate_scale)::numeric, 6)::double precision,
    'yPx', round(((layout_y - minimum_y) * coordinate_scale)::numeric, 6)::double precision,
    'widthPx', round((layout_width * coordinate_scale)::numeric, 6)::double precision,
    'heightPx', round((layout_height * coordinate_scale)::numeric, 6)::double precision,
    'viewportWidthPx', width,
    'viewportHeightPx', height
  ) order by id::text)
  into regions
  from public.devices
  where wall_id = requested_wall_id;

  return jsonb_build_object(
    'status', 'valid',
    'layoutMode', wall_mode,
    'widthPx', round(((maximum_x - minimum_x) * coordinate_scale)::numeric, 6)::double precision,
    'heightPx', round(((maximum_y - minimum_y) * coordinate_scale)::numeric, 6)::double precision,
    'geometryRevision', revision,
    'virtualPixelsPerMm', case when wall_mode = 'physical' then pixels_per_mm else null end,
    'devices', regions
  );
end;
$$;

-- Preserve every existing V1 player-state key. New clients may additionally
-- inspect virtual_wall_geometry and the scene's persisted V2 contract fields.
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
    'virtual_wall_geometry', public.current_virtual_wall_geometry(device.wall_id),
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
      'duration_seconds', current_scene.duration_seconds, 'device_ids', current_scene.device_ids,
      'wall_id', current_scene.wall_id, 'geometry_version', current_scene.geometry_version,
      'canvas_width_px', current_scene.canvas_width_px, 'canvas_height_px', current_scene.canvas_height_px,
      'wall_geometry_revision', current_scene.wall_geometry_revision
    ) end
  );
end;
$$;

revoke all on function public.geometry_number_text(double precision) from public, anon, authenticated;
revoke all on function public.geometry_fnv1a32(text) from public, anon, authenticated;
revoke all on function public.current_virtual_wall_geometry(uuid) from public, anon, authenticated;
grant execute on function public.get_player_state(uuid, uuid) to anon, authenticated;
