-- PLAYLIST-02 moves loading-scene configuration from walls to playlists and
-- adds collision-safe transactional item reordering.
alter table public.playlists
  add column loading_scene_id uuid references public.scenes(id) on delete set null;

-- Preserve the PLAYLIST-01 choice for every existing playlist on that wall.
-- The join also protects against copying legacy or otherwise invalid data.
update public.playlists playlist
set loading_scene_id = wall.loading_scene_id
from public.walls wall
join public.scenes scene on scene.id = wall.loading_scene_id and scene.wall_id = wall.id
where playlist.wall_id = wall.id
  and playlist.loading_scene_id is null;

drop trigger if exists walls_loading_scene_same_wall on public.walls;
drop function if exists public.validate_wall_loading_scene();

create or replace function public.validate_playlist_loading_scene()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  scene_wall_id uuid;
begin
  if new.loading_scene_id is null then return new; end if;
  select wall_id into scene_wall_id from public.scenes where id = new.loading_scene_id;
  if scene_wall_id is distinct from new.wall_id then
    raise exception 'Playlist loading scene must belong to the playlist wall'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create constraint trigger playlists_loading_scene_same_wall
after insert or update of loading_scene_id, wall_id on public.playlists
deferrable initially immediate
for each row execute function public.validate_playlist_loading_scene();

create or replace function public.validate_playlist_wall_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if exists (
    select 1
    from public.playlist_items item
    join public.scenes scene on scene.id = item.scene_id
    where item.playlist_id = new.id
      and scene.wall_id is distinct from new.wall_id
  ) or exists (
    select 1 from public.scenes scene
    where scene.id = new.loading_scene_id
      and scene.wall_id is distinct from new.wall_id
  ) then
    raise exception 'Playlist wall cannot differ from its item or loading scenes'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.validate_scene_wall_references()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.wall_id is not null and not exists (select 1 from public.walls where id = old.wall_id) then
    return new;
  end if;

  if exists (
    select 1
    from public.playlist_items item
    join public.playlists playlist on playlist.id = item.playlist_id
    where item.scene_id = new.id
      and playlist.wall_id is distinct from new.wall_id
  ) or exists (
    select 1 from public.playlists playlist
    where playlist.loading_scene_id = new.id
      and playlist.wall_id is distinct from new.wall_id
  ) then
    raise exception 'Scene wall cannot differ from playlist references'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

alter table public.walls drop column loading_scene_id;

create or replace function public.reorder_playlist_items(requested_playlist_id uuid, ordered_item_ids uuid[])
returns setof public.playlist_items
language plpgsql
set search_path = public
as $$
declare
  existing_count integer;
  requested_count integer;
  distinct_count integer;
  matched_count integer;
  maximum_position integer;
  temporary_offset integer;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;

  perform 1 from public.playlist_items
  where playlist_id = requested_playlist_id
  for update;

  select count(*), coalesce(max(position), -1)
  into existing_count, maximum_position
  from public.playlist_items
  where playlist_id = requested_playlist_id;

  requested_count := coalesce(cardinality(ordered_item_ids), 0);
  select count(distinct item_id), count(item.id)
  into distinct_count, matched_count
  from unnest(coalesce(ordered_item_ids, '{}'::uuid[])) item_id
  left join public.playlist_items item
    on item.id = item_id and item.playlist_id = requested_playlist_id;

  if requested_count <> existing_count
    or distinct_count <> requested_count
    or matched_count <> requested_count then
    raise exception 'Reorder must contain every playlist item exactly once'
      using errcode = '23514';
  end if;

  temporary_offset := maximum_position + existing_count + 1;
  update public.playlist_items
  set position = position + temporary_offset
  where playlist_id = requested_playlist_id;

  update public.playlist_items item
  set position = ordering.ordinality::integer - 1
  from unnest(coalesce(ordered_item_ids, '{}'::uuid[])) with ordinality as ordering(id, ordinality)
  where item.id = ordering.id
    and item.playlist_id = requested_playlist_id;

  return query
  select * from public.playlist_items
  where playlist_id = requested_playlist_id
  order by position, id;
end;
$$;

revoke all on function public.validate_playlist_loading_scene() from public, anon, authenticated;
revoke all on function public.reorder_playlist_items(uuid, uuid[]) from public, anon;
grant execute on function public.reorder_playlist_items(uuid, uuid[]) to authenticated;
