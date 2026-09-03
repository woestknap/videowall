-- A tiny time-only endpoint lets players take several NTP-style samples
-- without repeatedly loading their whole wall state.
create or replace function public.get_server_time()
returns timestamptz
language sql
security definer
set search_path = public
as $$
  select clock_timestamp();
$$;

grant execute on function public.get_server_time() to anon, authenticated;
