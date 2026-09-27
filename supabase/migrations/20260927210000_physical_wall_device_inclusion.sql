-- A paired device can remain assigned to its wall without contributing to a
-- physical V2 wall plane. Resolution walls and the legacy V1 device list keep
-- their existing behavior.
alter table public.devices
  add column if not exists included_in_wall boolean not null default true;

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
  where wall_id = requested_wall_id
    and (wall_mode <> 'physical' or included_in_wall);

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
  where wall_id = requested_wall_id
    and (wall_mode <> 'physical' or included_in_wall);

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
  where wall_id = requested_wall_id
    and (wall_mode <> 'physical' or included_in_wall);

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

revoke all on function public.current_virtual_wall_geometry(uuid) from public, anon, authenticated;
