create table public.media_assets (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 200),
  original_filename text not null check (char_length(original_filename) between 1 and 255),
  object_key text not null unique check (object_key ~ '^media/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[A-Za-z0-9][A-Za-z0-9._-]*$'),
  public_url text not null check (public_url ~ '^https://'),
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'video/mp4')),
  media_type text not null check (media_type in ('image', 'video')),
  size_bytes bigint not null check (size_bytes > 0),
  width integer check (width is null or width > 0),
  height integer check (height is null or height > 0),
  duration_seconds double precision check (duration_seconds is null or duration_seconds >= 0),
  thumbnail_object_key text,
  thumbnail_url text,
  created_at timestamptz not null default now(),
  created_by uuid not null default auth.uid() references auth.users(id) on delete restrict
);

alter table public.media_assets enable row level security;

-- This personal installation treats every signed-in editor as an administrator.
-- Ownership is still recorded and enforced on insert for future policy tightening.
create policy "signed-in admins view media assets"
on public.media_assets for select to authenticated
using (true);

create policy "signed-in admins create owned media assets"
on public.media_assets for insert to authenticated
with check (created_by = auth.uid());

create policy "signed-in admins update media assets"
on public.media_assets for update to authenticated
using (true) with check (true);

create policy "signed-in admins delete media assets"
on public.media_assets for delete to authenticated
using (true);
