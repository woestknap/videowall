-- A player may receive one independent lease for each live source. Keep the
-- legacy live_session projection while adding the complete lease collection.
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
  live_leases jsonb;
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

  select coalesce(jsonb_agg(jsonb_build_object(
    'sessionId', session_id,
    'liveSourceId', live_source_id,
    'targetDeviceId', target_device_id,
    'expiresAt', expires_at,
    'signalingUrl', signaling_url
  ) order by expires_at desc), '[]'::jsonb)
  into live_leases from public.live_session_leases
  where target_device_id = device.id and wall_id = device.wall_id and expires_at > now();

  return jsonb_build_object(
    'server_now', clock_timestamp(),
    'devices', wall_devices,
    'virtual_wall_geometry', public.current_virtual_wall_geometry(device.wall_id),
    'scene_started_at', scene_changed_at,
    'live_sessions', live_leases,
    'live_session', coalesce(live_leases -> 0, 'null'::jsonb),
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

grant execute on function public.get_player_state(uuid, uuid) to anon, authenticated;
