-- Correct the already-deployed PLAYLIST-03 start function. The deployed
-- record-shaped playlist selection omitted loop, then accessed playlist.loop.
-- Use explicit scalar fields so future partial SELECT changes cannot alter the
-- record shape used by the runtime snapshot.
create or replace function public.start_playlist(requested_wall_id uuid, requested_playlist_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  playlist_id uuid;
  playlist_wall_id uuid;
  playlist_name text;
  playlist_loop boolean;
  playlist_loading_scene_id uuid;
  snapshot jsonb;
  generation uuid := gen_random_uuid();
  runtime public.playlist_runtime;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;

  select p.id, p.wall_id, p.name, p.loop, p.loading_scene_id
  into playlist_id, playlist_wall_id, playlist_name, playlist_loop, playlist_loading_scene_id
  from public.playlists p
  where p.id = requested_playlist_id and p.wall_id = requested_wall_id
  for share;

  if playlist_id is null then raise exception 'Playlist does not belong to this wall' using errcode = '23514'; end if;

  select jsonb_build_object(
    'loop', playlist_loop,
    'loading_scene_id', playlist_loading_scene_id,
    'items', coalesce(jsonb_agg(jsonb_build_object(
      'item_id', item.id, 'scene_id', item.scene_id, 'scene_name', scene.name,
      'duration_seconds', item.duration_seconds, 'position', item.position
    ) order by item.position, item.id), '[]'::jsonb)
  ) into snapshot
  from public.playlist_items item
  join public.scenes scene on scene.id = item.scene_id and scene.wall_id = playlist_wall_id
  where item.playlist_id = playlist_id;

  if jsonb_array_length(snapshot -> 'items') = 0 then raise exception 'Playlist must contain at least one valid item' using errcode = '23514'; end if;

  insert into public.playlist_runtime(
    wall_id, playlist_id, playlist_name, status, phase, generation, sequence,
    snapshot, current_index, loading_scene_id, updated_at
  ) values (
    requested_wall_id, playlist_id, playlist_name, 'PLAYING', 'DISPLAYING', generation, 0,
    snapshot, -1, playlist_loading_scene_id, clock_timestamp()
  ) on conflict (wall_id) do update set
    playlist_id = excluded.playlist_id, playlist_name = excluded.playlist_name,
    status = excluded.status, phase = excluded.phase, generation = excluded.generation,
    sequence = 0, snapshot = excluded.snapshot, current_index = -1,
    current_item_id = null, current_scene_id = null, target_index = null,
    target_item_id = null, target_scene_id = null, loading_scene_id = excluded.loading_scene_id,
    started_at = null, next_transition_at = null, paused_remaining_ms = null,
    transition_deadline_at = null, expected_device_ids = '{}', ready_device_ids = '{}',
    failed_device_ids = '{}', degraded = false, pause_after_transition = false,
    updated_at = excluded.updated_at
  returning * into runtime;

  return public.begin_playlist_transition_locked(requested_wall_id, generation, 0, 0, false);
end;
$$;

revoke all on function public.start_playlist(uuid, uuid) from public, anon;
grant execute on function public.start_playlist(uuid, uuid) to authenticated;
