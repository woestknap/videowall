-- Single-admin personal videowall. Run with `supabase db push` after linking.
create extension if not exists pgcrypto;

create table public.walls (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 100),
  created_at timestamptz not null default now()
);
create table public.devices (
  id uuid primary key default gen_random_uuid(),
  wall_id uuid not null references public.walls(id) on delete cascade,
  name text not null,
  player_token uuid not null default gen_random_uuid(),
  width integer,
  height integer,
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);
create table public.pairing_pins (
  pin text primary key check (pin ~ '^[0-9]{6}$'),
  wall_id uuid not null references public.walls(id) on delete cascade,
  expires_at timestamptz not null,
  claimed_at timestamptz,
  created_at timestamptz not null default now()
);
create table public.scenes (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 100),
  layers jsonb not null default '[]'::jsonb,
  duration_seconds integer not null default 60 check (duration_seconds between 1 and 86400),
  created_at timestamptz not null default now()
);
create table public.wall_state (
  wall_id uuid primary key references public.walls(id) on delete cascade,
  active_scene_id uuid references public.scenes(id) on delete set null,
  playback_mode text not null default 'manual' check (playback_mode in ('manual','cycle','disabled')),
  changed_at timestamptz not null default now()
);

alter table public.walls enable row level security;
alter table public.devices enable row level security;
alter table public.pairing_pins enable row level security;
alter table public.scenes enable row level security;
alter table public.wall_state enable row level security;

-- For this personal project, any signed-in user is the administrator.
create policy "signed-in admin manages walls" on public.walls for all to authenticated using (true) with check (true);
create policy "signed-in admin manages devices" on public.devices for all to authenticated using (true) with check (true);
create policy "signed-in admin manages pins" on public.pairing_pins for all to authenticated using (true) with check (true);
create policy "signed-in admin manages scenes" on public.scenes for all to authenticated using (true) with check (true);
create policy "signed-in admin manages state" on public.wall_state for all to authenticated using (true) with check (true);

create or replace function public.create_pairing_pin(requested_wall_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare new_pin text;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  loop
    new_pin := lpad(floor(random() * 1000000)::text, 6, '0');
    begin
      insert into pairing_pins(pin, wall_id, expires_at) values (new_pin, requested_wall_id, now() + interval '10 minutes');
      return new_pin;
    exception when unique_violation then end;
  end loop;
end $$;

create or replace function public.claim_pairing_pin(pin_value text, device_name text, viewport_width integer, viewport_height integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare pairing pairing_pins; new_device devices;
begin
  select * into pairing from pairing_pins where pin = pin_value and claimed_at is null and expires_at > now() for update;
  if pairing.pin is null then raise exception 'That PIN is invalid or expired'; end if;
  insert into devices(wall_id, name, width, height, last_seen_at) values (pairing.wall_id, left(device_name, 100), viewport_width, viewport_height, now()) returning * into new_device;
  update pairing_pins set claimed_at = now() where pin = pairing.pin;
  return jsonb_build_object('id', new_device.id, 'token', new_device.player_token);
end $$;

create or replace function public.player_heartbeat(requested_device_id uuid, requested_token uuid, viewport_width integer, viewport_height integer)
returns void language plpgsql security definer set search_path = public as $$
begin
  update devices set last_seen_at = now(), width = viewport_width, height = viewport_height where id = requested_device_id and player_token = requested_token;
  if not found then raise exception 'Unknown player'; end if;
end $$;

create or replace function public.get_player_state(requested_device_id uuid, requested_token uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare device devices; current_scene scenes;
begin
  select * into device from devices where id = requested_device_id and player_token = requested_token;
  if device.id is null then raise exception 'Unknown player'; end if;
  select s.* into current_scene from wall_state ws join scenes s on s.id = ws.active_scene_id where ws.wall_id = device.wall_id;
  return jsonb_build_object('scene', case when current_scene.id is null then null else jsonb_build_object('id', current_scene.id, 'name', current_scene.name, 'layers', current_scene.layers, 'duration_seconds', current_scene.duration_seconds) end);
end $$;

grant execute on function public.create_pairing_pin(uuid) to authenticated;
grant execute on function public.claim_pairing_pin(text, text, integer, integer) to anon, authenticated;
grant execute on function public.player_heartbeat(uuid, uuid, integer, integer) to anon, authenticated;
grant execute on function public.get_player_state(uuid, uuid) to anon, authenticated;
