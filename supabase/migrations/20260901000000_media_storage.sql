-- Media is intentionally public: paired players must be able to render it without an admin session.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', true, 52428800, array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm'])
on conflict (id) do update set public = true, file_size_limit = 52428800;

create policy "authenticated admin uploads media"
on storage.objects for insert to authenticated
with check (bucket_id = 'media');

create policy "authenticated admin updates media"
on storage.objects for update to authenticated
using (bucket_id = 'media') with check (bucket_id = 'media');

create policy "authenticated admin deletes media"
on storage.objects for delete to authenticated
using (bucket_id = 'media');
