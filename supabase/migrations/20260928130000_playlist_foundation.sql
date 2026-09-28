-- PLAYLIST-01: persisted wall playlists and the optional future transition scene.
alter table public.walls
  add column loading_scene_id uuid references public.scenes(id) on delete set null;

create table public.playlists (
  id uuid primary key default gen_random_uuid(),
  wall_id uuid not null references public.walls(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  loop boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.playlist_items (
  id uuid primary key default gen_random_uuid(),
  playlist_id uuid not null references public.playlists(id) on delete cascade,
  scene_id uuid not null references public.scenes(id) on delete cascade,
  position integer not null check (position >= 0),
  duration_seconds integer not null default 30 check (duration_seconds > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (playlist_id, position)
);

create index playlists_wall_id_idx on public.playlists(wall_id);
create index playlist_items_scene_id_idx on public.playlist_items(scene_id);

create or replace function public.set_playlist_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger playlists_set_updated_at
before update on public.playlists
for each row execute function public.set_playlist_updated_at();

create trigger playlist_items_set_updated_at
before update on public.playlist_items
for each row execute function public.set_playlist_updated_at();

create or replace function public.validate_playlist_item_scene_wall()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  playlist_wall_id uuid;
  scene_wall_id uuid;
begin
  select wall_id into playlist_wall_id from public.playlists where id = new.playlist_id;
  select wall_id into scene_wall_id from public.scenes where id = new.scene_id;

  if playlist_wall_id is not null and scene_wall_id is distinct from playlist_wall_id then
    raise exception 'Playlist items must reference a scene from the playlist wall'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create constraint trigger playlist_items_same_wall
after insert or update of playlist_id, scene_id on public.playlist_items
deferrable initially immediate
for each row execute function public.validate_playlist_item_scene_wall();

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
  ) then
    raise exception 'Playlist wall cannot differ from its item scenes'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create constraint trigger playlists_same_wall_after_wall_change
after update of wall_id on public.playlists
deferrable initially immediate
for each row execute function public.validate_playlist_wall_change();

create or replace function public.validate_wall_loading_scene()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  scene_wall_id uuid;
begin
  if new.loading_scene_id is null then return new; end if;
  select wall_id into scene_wall_id from public.scenes where id = new.loading_scene_id;
  if scene_wall_id is distinct from new.id then
    raise exception 'Loading scene must belong to the same wall'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create constraint trigger walls_loading_scene_same_wall
after insert or update of loading_scene_id on public.walls
deferrable initially immediate
for each row execute function public.validate_wall_loading_scene();

create or replace function public.validate_scene_wall_references()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- A cascading wall deletion may set scenes.wall_id to null while deleting the
  -- same wall's playlists. That operation is safe and must remain possible.
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
    select 1 from public.walls wall
    where wall.loading_scene_id = new.id
      and wall.id is distinct from new.wall_id
  ) then
    raise exception 'Scene wall cannot differ from playlist or loading-scene references'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create constraint trigger scenes_same_wall_after_wall_change
after update of wall_id on public.scenes
deferrable initially immediate
for each row execute function public.validate_scene_wall_references();

alter table public.playlists enable row level security;
alter table public.playlist_items enable row level security;

-- ScreenMesh is currently a personal installation: every authenticated editor
-- has the same administrator access used for walls and scenes.
create policy "signed-in admin manages playlists"
on public.playlists for all to authenticated
using (true) with check (true);

create policy "signed-in admin manages playlist items"
on public.playlist_items for all to authenticated
using (true) with check (true);

revoke all on function public.set_playlist_updated_at() from public, anon, authenticated;
revoke all on function public.validate_playlist_item_scene_wall() from public, anon, authenticated;
revoke all on function public.validate_playlist_wall_change() from public, anon, authenticated;
revoke all on function public.validate_wall_loading_scene() from public, anon, authenticated;
revoke all on function public.validate_scene_wall_references() from public, anon, authenticated;
