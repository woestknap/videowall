# Media library and Cloudflare R2

## Storage boundary

The reusable media library separates metadata from playback files:

- Supabase stores `media_assets` metadata and continues to own authentication, scenes, walls and devices.
- Cloudflare R2 stores playback-ready JPEG, PNG, WebP and MP4 files. It is not an archive for camera originals or master exports; keep those files on local storage or a NAS.
- The Railway Node service authenticates editor requests and signs short-lived R2 uploads or performs scoped deletion. It never receives or proxies media bytes.
- The browser uploads the file directly to R2 with the presigned PUT URL. R2 credentials remain server-side and are never compiled into the browser bundle.
- Pi players read stable public URLs under `R2_PUBLIC_BASE_URL`; signed GET URLs are not used.

The current editor upload UI still uses the existing public Supabase Storage `media` bucket. Existing scenes containing only `SceneLayer.content.url` remain valid. A later media-library UI phase can request an R2 upload URL, upload directly, insert `media_assets` metadata through Supabase, and store both `mediaAssetId` and `url` on a layer.

## Railway configuration

Configure these server-only variables alongside the signaling variables. Never give them a `VITE_` prefix and never expose or log their values.

| Variable | Purpose |
| --- | --- |
| `R2_ACCOUNT_ID` | Cloudflare account that owns the bucket. |
| `R2_ACCESS_KEY_ID` | R2 API token access key. |
| `R2_SECRET_ACCESS_KEY` | R2 API token secret. |
| `R2_BUCKET_NAME` | Bucket containing playback-ready media. |
| `R2_PUBLIC_BASE_URL` | HTTPS origin used by players, such as `https://media.example.com`. |

`POST /api/media/upload-url` accepts authenticated JSON containing `filename`, `mimeType`, and `sizeBytes`. It returns a five-minute PUT URL plus the generated `objectKey` and stable `publicUrl`. Uploads are limited to supported image formats and MP4, with a 500 MiB server-side maximum. `DELETE /api/media/object` accepts an authenticated `{ "objectKey": "..." }` body and only permits generated `media/<uuid>/<safe-filename>` keys in the configured bucket.

Both endpoints require a current Supabase access token in `Authorization: Bearer <token>` and use the signaling origin allowlist for browser CORS. WebSocket signaling remains on the same process and port.

## Cloudflare setup

Create a dedicated R2 bucket, attach the intended public custom domain, and create a narrowly scoped R2 API token with object read/write access to that bucket. Configure bucket CORS to allow the deployed editor origins to `PUT` the four supported content types. Public playback must be available at the exact HTTPS origin configured by `R2_PUBLIC_BASE_URL`.

Applying the Supabase migration creates the catalog and its row-level-security policies. It does not copy or delete objects in the legacy Supabase bucket.

## Temporary MEDIA-01A.1 verification

The signed-in dashboard temporarily includes **Test R2 upload**. Choose a supported playback-ready file and run the test. The browser requests authorization from the HTTP origin corresponding to `VITE_SIGNALING_URL`, then PUTs the file directly to R2. Success displays the generated object key, public URL, byte size and MIME type. This probe does not insert `media_assets` metadata or update scenes.

Because that authorization request is cross-origin, the deployed Railway `SIGNALING_ALLOWED_ORIGINS` must include the editor's exact origin, including `http://localhost:5173` when testing locally. Allowed media preflights return `204` and advertise only `POST`, `DELETE`, `OPTIONS`, `Authorization`, and `Content-Type`; wildcard origins are never used.

Remove `src/admin/R2UploadTestPanel.tsx`, `src/lib/manualR2Upload.ts`, their test, styles, and the single `Admin.tsx` import/render when MEDIA-01B replaces the probe with the real media-library flow.
