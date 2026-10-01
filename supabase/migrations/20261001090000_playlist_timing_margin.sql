-- PLAYLIST-04 timing margin: tolerate a delayed transition poll without
-- changing the transition state machine or readiness contract.

create or replace function public.playlist_loading_lead_time()
returns interval
language sql
immutable
set search_path = public
as $$ select interval '1500 milliseconds' $$;

create or replace function public.playlist_activation_lead_time()
returns interval
language sql
immutable
set search_path = public
as $$ select interval '2000 milliseconds' $$;

revoke all on function public.playlist_loading_lead_time() from public, anon, authenticated;
revoke all on function public.playlist_activation_lead_time() from public, anon, authenticated;
