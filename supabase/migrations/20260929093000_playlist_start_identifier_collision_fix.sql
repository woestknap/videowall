-- Correct the prior Start fix: its local playlist_id collided with the
-- playlist_items.playlist_id column in the snapshot query.
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
    snapshot, current_index, loading_scene_id, updated_at
  ) values (
    requested_wall_id, v_playlist_id, v_playlist_name, 'PLAYING', 'DISPLAYING', v_generation, 0,
    v_snapshot, -1, v_playlist_loading_scene_id, clock_timestamp()
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
  returning * into v_runtime;

  return public.begin_playlist_transition_locked(requested_wall_id, v_generation, 0, 0, false);
end;
$$;

revoke all on function public.start_playlist(uuid, uuid) from public, anon;
grant execute on function public.start_playlist(uuid, uuid) to authenticated;
