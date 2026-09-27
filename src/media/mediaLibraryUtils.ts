import type { MediaAsset, Scene, SceneLayer } from '../types'

export type MediaFilter = 'all' | 'image' | 'video'
export type MediaSort = 'newest' | 'oldest' | 'name'

export const ALLOWED_MEDIA_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4'] as const
export const MAX_MEDIA_UPLOAD_BYTES = 500 * 1024 * 1024

type MediaMetadata = { width: number | null; height: number | null; durationSeconds: number | null }
type UploadAuthorization = { uploadUrl: string; objectKey: string; publicUrl: string }
type MediaAssetInsert = Omit<MediaAsset, 'id' | 'created_at' | 'thumbnail_object_key' | 'thumbnail_url'> & { thumbnail_object_key?: null; thumbnail_url?: null }

export type MediaUploadActions = {
  readMetadata(file: File): Promise<MediaMetadata>
  authorize(file: File): Promise<UploadAuthorization>
  upload(file: File, uploadUrl: string): Promise<void>
  insert(row: MediaAssetInsert): Promise<MediaAsset>
  cleanup(objectKey: string): Promise<void>
}

export type MediaDeleteActions = { deleteObject(objectKey: string): Promise<void>; deleteMetadata(assetId: string): Promise<void> }

export function mediaTypeForMime(mimeType: string): MediaAsset['media_type'] | null {
  if (['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) return 'image'
  if (mimeType === 'video/mp4') return 'video'
  return null
}

export function validateMediaFile(file: Pick<File, 'name' | 'type' | 'size'>) {
  if (!file.name.trim() || file.name.length > 255 || /[\\/\u0000-\u001f\u007f]/.test(file.name)) throw new Error('Choose a file with a safe name of at most 255 characters.')
  const mediaType = mediaTypeForMime(file.type)
  if (!mediaType) throw new Error('Use a JPEG, PNG, WebP, or MP4 playback file.')
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_MEDIA_UPLOAD_BYTES) throw new Error('File size must be between 1 byte and 500 MB.')
  return mediaType
}

export function assetName(filename: string) {
  return (filename.replace(/\.[^.]*$/, '').trim() || 'Untitled media').slice(0, 200)
}

export async function createMediaAssetFromUpload(file: File, createdBy: string, actions: MediaUploadActions) {
  const mediaType = validateMediaFile(file)
  const metadata = await actions.readMetadata(file)
  const authorization = await actions.authorize(file)
  await actions.upload(file, authorization.uploadUrl)
  const row: MediaAssetInsert = {
    name: assetName(file.name),
    original_filename: file.name,
    object_key: authorization.objectKey,
    public_url: authorization.publicUrl,
    mime_type: file.type,
    media_type: mediaType,
    size_bytes: file.size,
    width: metadata.width,
    height: metadata.height,
    duration_seconds: metadata.durationSeconds,
    created_by: createdBy,
    thumbnail_object_key: null,
    thumbnail_url: null,
  }
  try {
    return await actions.insert(row)
  } catch (insertError) {
    const detail = insertError instanceof Error ? insertError.message : 'Metadata insert failed.'
    try { await actions.cleanup(authorization.objectKey) }
    catch { throw new Error(`${detail} The R2 upload could not be cleaned up; an orphaned object may remain at ${authorization.objectKey}.`) }
    throw new Error(`${detail} The uploaded R2 object was cleaned up.`)
  }
}

export async function deleteUnusedMediaAsset(asset: MediaAsset, usageCount: number, actions: MediaDeleteActions) {
  if (usageCount > 0) throw new Error(`This asset is used in ${usageCount} scene${usageCount === 1 ? '' : 's'} and cannot be deleted.`)
  await actions.deleteObject(asset.object_key)
  try { await actions.deleteMetadata(asset.id) }
  catch (error) {
    const detail = error instanceof Error ? error.message : 'Metadata deletion failed.'
    throw new Error(`The R2 object was deleted, but its metadata row remains. ${detail}`)
  }
}

export function filterAndSortMedia(assets: MediaAsset[], search: string, filter: MediaFilter, sort: MediaSort) {
  const query = search.trim().toLocaleLowerCase()
  return assets
    .filter(asset => filter === 'all' || asset.media_type === filter)
    .filter(asset => !query || asset.name.toLocaleLowerCase().includes(query) || asset.original_filename.toLocaleLowerCase().includes(query))
    .sort((left, right) => sort === 'name'
      ? left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
      : sort === 'oldest'
        ? Date.parse(left.created_at) - Date.parse(right.created_at)
        : Date.parse(right.created_at) - Date.parse(left.created_at))
}

export function mediaUsageCounts(scenes: Pick<Scene, 'id' | 'layers'>[]) {
  const sceneIdsByAsset = new Map<string, Set<string>>()
  for (const scene of scenes) {
    for (const layer of scene.layers) {
      const assetId = layer.content.mediaAssetId
      if (!assetId) continue
      const sceneIds = sceneIdsByAsset.get(assetId) ?? new Set<string>()
      sceneIds.add(scene.id)
      sceneIdsByAsset.set(assetId, sceneIds)
    }
  }
  return new Map([...sceneIdsByAsset].map(([assetId, sceneIds]) => [assetId, sceneIds.size]))
}

export function assetMatchesLayerType(asset: MediaAsset, layerType: SceneLayer['type']) {
  return (layerType === 'image' || layerType === 'video') && asset.media_type === layerType
}

export function mediaAspectRatio(sourceWidth: number | null, sourceHeight: number | null) {
  if (typeof sourceWidth !== 'number' || !Number.isFinite(sourceWidth) || sourceWidth <= 0
    || typeof sourceHeight !== 'number' || !Number.isFinite(sourceHeight) || sourceHeight <= 0) return null
  const ratio = sourceWidth / sourceHeight
  return Number.isFinite(ratio) && ratio > 0 ? ratio : null
}

export function mediaDimensionChange(layer: Pick<SceneLayer, 'width' | 'height' | 'lockedAspect' | 'aspectRatio'>, key: 'width' | 'height', value: number): Partial<Pick<SceneLayer, 'width' | 'height'>> {
  if (!Number.isFinite(value) || value <= 0) return {}
  const ratio = layer.aspectRatio
  if (layer.lockedAspect === false || typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0) return { [key]: value }
  const pairedValue = key === 'width' ? value / ratio : value * ratio
  if (!Number.isFinite(pairedValue) || pairedValue <= 0) return { [key]: value }
  return key === 'width' ? { width: value, height: pairedValue } : { width: pairedValue, height: value }
}

export type InitialMediaSizing = 'preserve' | 'match-aspect' | 'intrinsic'

export function layerWithMediaAsset(layer: SceneLayer, asset: MediaAsset, initialSizing: InitialMediaSizing = 'preserve'): SceneLayer {
  if (!assetMatchesLayerType(asset, layer.type)) throw new Error(`A ${asset.media_type} asset cannot be used by a ${layer.type} layer.`)
  const aspectRatio = mediaAspectRatio(asset.width, asset.height)
  const sourceDimensions = aspectRatio
    ? { sourceWidth: asset.width!, sourceHeight: asset.height!, aspectRatio }
    : {}
  const aspectHeight = aspectRatio ? layer.width / aspectRatio : Number.NaN
  const initialImageSize = initialSizing === 'match-aspect' && layer.type === 'image'
    && Number.isFinite(layer.width) && layer.width > 0 && Number.isFinite(aspectHeight) && aspectHeight > 0
    ? { height: aspectHeight }
    : {}
  const intrinsicSize = initialSizing === 'intrinsic' && aspectRatio
    ? { width: asset.width!, height: asset.height! }
    : {}
  return {
    ...layer,
    content: { ...layer.content, mediaAssetId: asset.id, url: asset.public_url },
    ...sourceDimensions,
    ...initialImageSize,
    ...intrinsicSize,
  }
}

export function layerPlaybackUrl(layer: SceneLayer) {
  return layer.content.url
}

export function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  const precision = value >= 100 || Number.isInteger(value) ? 0 : 1
  return `${value.toFixed(precision)} ${units[unit]}`
}

export function formatDimensions(width: number | null, height: number | null) {
  return width && height ? `${width} × ${height}` : 'Dimensions unavailable'
}

export function formatDuration(seconds: number | null) {
  if (seconds === null || !Number.isFinite(seconds)) return null
  const rounded = Math.max(0, Math.round(seconds))
  const hours = Math.floor(rounded / 3600)
  const minutes = Math.floor(rounded % 3600 / 60)
  const remainder = rounded % 60
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}` : `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
}
