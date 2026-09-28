# Media library and Cloudflare R2

## Storage boundary

The reusable media library separates metadata from playback files:

- Supabase stores `media_assets` metadata and continues to own authentication, scenes, walls and devices.
- Cloudflare R2 stores playback-ready JPEG, PNG, WebP and MP4 files. It is not an archive for camera originals or master exports; keep those files on local storage or a NAS.
- The Railway Node service authenticates editor requests and signs short-lived R2 uploads or performs scoped deletion. It never receives or proxies media bytes.
- The browser uploads the file directly to R2 with the presigned PUT URL. R2 credentials remain server-side and are never compiled into the browser bundle.
- Pi players read stable public URLs under `R2_PUBLIC_BASE_URL`; signed GET URLs are not used.

The dashboard now provides the reusable Media Library, and image/video layers can either choose an existing compatible asset or upload a new one. Selection stores both `mediaAssetId` and the stable `url`; players continue rendering the URL directly. Existing scenes containing only `SceneLayer.content.url`, including URLs from the legacy public Supabase Storage `media` bucket, remain valid without migration.

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

## Library workflow

The signed-in dashboard library supports upload, name/filename search, image/video filtering, newest/name/oldest sorting, metadata inspection, distinct-scene usage counts, and deletion of unused assets. The same component opens as a type-constrained picker from image and video layers.

For a new asset, the browser validates the MIME type and 500 MiB limit, reads dimensions and video duration locally, requests a presigned URL, uploads directly to R2, then inserts the `media_assets` row through Supabase. If the metadata insert fails, it attempts to delete the newly uploaded R2 object and reports whether an orphan may remain. No file bytes pass through Railway.

Deletion is deliberately object-first: a fresh client-side scan of scene `layers` blocks referenced assets, Railway deletes the validated `media/<uuid>/<safe-filename>` R2 key, and only then does Supabase delete the metadata row. The backend remains restricted to authenticated users, the configured bucket, and generated media keys. The current single-admin authorization model permits any signed-in editor to manage catalog assets.

Because that authorization request is cross-origin, the deployed Railway `SIGNALING_ALLOWED_ORIGINS` must include the editor's exact origin, including `http://localhost:5173` when testing locally. Allowed media preflights return `204` and advertise only `POST`, `DELETE`, `OPTIONS`, `Authorization`, and `Content-Type`; wildcard origins are never used.

## Local video conversion

Only playback-ready derivatives belong in R2. Original/master video remains on the user's computer or NAS: ScreenMesh does not upload masters for conversion, proxy files through Railway, run FFmpeg in the cloud, or upload converted files automatically.

The public sign-in page provides direct downloads for [Windows](/downloads/ScreenMesh-Convert-Windows.zip) and [macOS](/downloads/ScreenMesh-Convert-macOS.command). They operate only on files or directories explicitly supplied by the user and write results beside each source in `ScreenMesh Converted/`, using names such as `presentation.screenmesh.mp4`. Existing output names receive a numbered suffix; originals are never overwritten.

Both converters require a local FFmpeg installation that includes `ffprobe`. Windows reports a suggested `winget install Gyan.FFmpeg` route when it is missing. On macOS, install it with `brew install ffmpeg`; after downloading the `.command` file, run `chmod +x ScreenMesh-Convert-macOS.command` once if Finder does not allow it to open.

The ScreenMesh V1 profile is MP4 with H.264 (`libx264`, High profile, Level 4.1), `yuv420p`, medium preset, CRF 20, 12M max rate / 24M buffer, `+faststart`, and an optional AAC audio stream at 160k. It preserves aspect ratio, scales down only to a maximum 1920×1080 even-pixel bounding box, caps output at 30 fps without raising lower frame rates, and does not add audio when the source has none.

Windows: download and extract the ZIP, then drag one or more video files/folders onto the included `.cmd` launcher; it runs the adjacent PowerShell converter. macOS: double-click the `.command` file to choose one video, or run it in Terminal with one or more files/folders. The tools print PASS / FAILED / SKIPPED summaries; folders skip `ScreenMesh Converted` and already converted `.screenmesh.mp4` files. Upload the resulting MP4 from the signed-in Media Library.
