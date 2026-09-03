alter table public.devices add column if not exists auto_size boolean not null default true;

-- Make existing boundaries use the actual browser viewport last reported by each Pi.
update public.devices
set layout_width = width,
    layout_height = height
where auto_size = true
  and width is not null
  and height is not null;

-- Pair newly flashed Pis directly into the freeform workspace at their detected size.
create or replace function public.claim_pairing_pin(pin_value text, device_name text, viewport_width integer, viewport_height integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  pairing public.pairing_pins;
  new_device public.devices;
  next_x double precision;
begin
  select * into pairing
  from public.pairing_pins
  where pin = pin_value and claimed_at is null and expires_at > now()
  for update;

  if pairing.pin is null then
    raise exception 'That PIN is invalid or expired';
  end if;

  select coalesce(max(layout_x + layout_width), 0) into next_x
  from public.devices
  where wall_id = pairing.wall_id;

  insert into public.devices(
    wall_id, name, width, height, last_seen_at,
    layout_x, layout_y, layout_width, layout_height, auto_size
  ) values (
    pairing.wall_id, left(device_name, 100), viewport_width, viewport_height, now(),
    next_x, 0, viewport_width, viewport_height, true
  ) returning * into new_device;

  update public.pairing_pins set claimed_at = now() where pin = pairing.pin;
  return jsonb_build_object('id', new_device.id, 'token', new_device.player_token);
end;
$$;

create or replace function public.player_heartbeat(requested_device_id uuid, requested_token uuid, viewport_width integer, viewport_height integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.devices
  set last_seen_at = now(),
      width = viewport_width,
      height = viewport_height,
      layout_width = case when auto_size then viewport_width else layout_width end,
      layout_height = case when auto_size then viewport_height else layout_height end
  where id = requested_device_id and player_token = requested_token;

  if not found then
    raise exception 'Unknown player';
  end if;
end;
$$;
