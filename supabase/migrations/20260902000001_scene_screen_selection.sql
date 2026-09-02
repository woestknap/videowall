-- An empty device list means that every display on the wall is used by the scene.
alter table public.scenes add column if not exists device_ids uuid[] not null default '{}';

-- Give the first Pi displays a realistic 16:9 physical footprint rather than a square.
with ranked as (
  select id, row_number() over (partition by wall_id order by created_at) - 1 as position
  from public.devices
  where layout_width = 1 and layout_height = 1
)
update public.devices d
set layout_x = ranked.position * 16,
    layout_y = 0,
    layout_width = 16,
    layout_height = 9
from ranked
where d.id = ranked.id;

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
begin
  select * into device
  from public.devices
  where id = requested_device_id and player_token = requested_token;

  if device.id is null then
    raise exception 'Unknown player';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', id,
        'layout_x', layout_x,
        'layout_y', layout_y,
        'layout_width', layout_width,
        'layout_height', layout_height
      )
      order by layout_y, layout_x
    ),
    '[]'::jsonb
  )
  into wall_devices
  from public.devices
  where wall_id = device.wall_id;

  select s.* into current_scene
  from public.wall_state ws
  join public.scenes s on s.id = ws.active_scene_id
  where ws.wall_id = device.wall_id;

  select changed_at into scene_changed_at
  from public.wall_state
  where wall_id = device.wall_id;

  return jsonb_build_object(
    'server_now', clock_timestamp(),
    'devices', wall_devices,
    'scene_started_at', scene_changed_at,
    'scene', case
      when current_scene.id is null then null
      else jsonb_build_object(
        'id', current_scene.id,
        'name', current_scene.name,
        'layers', current_scene.layers,
        'duration_seconds', current_scene.duration_seconds,
        'device_ids', current_scene.device_ids
      )
    end
  );
end;
$$;
