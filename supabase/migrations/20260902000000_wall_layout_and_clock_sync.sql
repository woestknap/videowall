alter table public.devices add column if not exists layout_x integer not null default 0;
alter table public.devices add column if not exists layout_y integer not null default 0;
alter table public.devices add column if not exists layout_width integer not null default 1;
alter table public.devices add column if not exists layout_height integer not null default 1;

-- Existing displays are laid out side-by-side in their order of pairing.
with ranked as (
  select id, row_number() over (partition by wall_id order by created_at) - 1 as next_x
  from public.devices
)
update public.devices d set layout_x = ranked.next_x from ranked where d.id = ranked.id;

create or replace function public.get_player_state(requested_device_id uuid, requested_token uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare device devices; current_scene scenes; wall_devices jsonb; scene_changed_at timestamptz;
begin
  select * into device from devices where id = requested_device_id and player_token = requested_token;
  if device.id is null then raise exception 'Unknown player'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'layout_x', layout_x, 'layout_y', layout_y, 'layout_width', layout_width, 'layout_height', layout_height) order by layout_y, layout_x), '[]'::jsonb)
    into wall_devices from devices where wall_id = device.wall_id;
  select s.* into current_scene from wall_state ws join scenes s on s.id = ws.active_scene_id where ws.wall_id = device.wall_id;
  select changed_at into scene_changed_at from wall_state where wall_id = device.wall_id;
  return jsonb_build_object(
    'server_now', clock_timestamp(),
    'devices', wall_devices,
    'scene_started_at', scene_changed_at,
    'scene', case when current_scene.id is null then null else jsonb_build_object('id', current_scene.id, 'name', current_scene.name, 'layers', current_scene.layers, 'duration_seconds', current_scene.duration_seconds) end
  );
end $$;
