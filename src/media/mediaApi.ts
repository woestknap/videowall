import { supabase } from '../lib/supabase'
import type { MediaAsset } from '../types'
import { createMediaAssetFromUpload, deleteUnusedMediaAsset, mediaTypeForMime } from './mediaLibraryUtils'

type UploadAuthorization = { uploadUrl: string; objectKey: string; publicUrl: string }
type MediaMetadata = { width: number | null; height: number | null; durationSeconds: number | null }

export function signalingHttpOrigin(signalingUrl: string) {
  let parsed: URL
  try { parsed = new URL(signalingUrl) } catch { throw new Error('Signaling URL is not configured correctly.') }
  if (parsed.protocol === 'ws:') parsed.protocol = 'http:'
  else if (parsed.protocol === 'wss:') parsed.protocol = 'https:'
  else throw new Error('Signaling URL must use ws:// or wss://.')
  return parsed.origin
}

async function responseError(response: Response, fallback: string) {
  try {
    const body = await response.json() as { error?: unknown }
    if (typeof body.error === 'string' && body.error) return body.error
  } catch { /* R2 may return an empty or XML error body. */ }
  return `${fallback} (${response.status} ${response.statusText || 'HTTP error'})`
}

function loadElementMetadata(file: File, mediaType: 'image' | 'video') {
  return new Promise<MediaMetadata>((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file)
    const cleanup = () => URL.revokeObjectURL(objectUrl)
    if (mediaType === 'image') {
      const image = new Image()
      image.onload = () => { const result = { width: image.naturalWidth || null, height: image.naturalHeight || null, durationSeconds: null }; cleanup(); resolve(result) }
      image.onerror = () => { cleanup(); reject(new Error('Image metadata could not be read.')) }
      image.src = objectUrl
      return
    }
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.onloadedmetadata = () => {
      const result = { width: video.videoWidth || null, height: video.videoHeight || null, durationSeconds: Number.isFinite(video.duration) ? video.duration : null }
      video.removeAttribute('src'); video.load(); cleanup(); resolve(result)
    }
    video.onerror = () => { video.removeAttribute('src'); video.load(); cleanup(); reject(new Error('Video metadata could not be read.')) }
    video.src = objectUrl
  })
}

async function currentSession() {
  if (!supabase) throw new Error('Supabase is not configured.')
  const { data, error } = await supabase.auth.getSession()
  if (error || !data.session?.access_token || !data.session.user.id) throw new Error('Sign in again to manage media.')
  return { accessToken: data.session.access_token, userId: data.session.user.id }
}

function mediaEndpoint(path: string) {
  const signalingUrl = import.meta.env.VITE_SIGNALING_URL
  if (!signalingUrl) throw new Error('VITE_SIGNALING_URL is not configured.')
  return `${signalingHttpOrigin(signalingUrl)}${path}`
}

async function deleteR2Object(objectKey: string, accessToken: string) {
  let response: Response
  try { response = await fetch(mediaEndpoint('/api/media/object'), { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ objectKey }) }) }
  catch { throw new Error('Could not reach the media backend for R2 deletion.') }
  if (!response.ok) throw new Error(await responseError(response, 'R2 object deletion failed'))
}

export async function uploadMediaAsset(file: File) {
  const client = supabase
  if (!client) throw new Error('Supabase is not configured.')
  const { accessToken, userId } = await currentSession()
  return createMediaAssetFromUpload(file, userId, {
    readMetadata: candidate => {
      const type = mediaTypeForMime(candidate.type)
      if (!type) throw new Error('Unsupported media type.')
      return loadElementMetadata(candidate, type)
    },
    async authorize(candidate) {
      let response: Response
      try { response = await fetch(mediaEndpoint('/api/media/upload-url'), { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: candidate.name, mimeType: candidate.type, sizeBytes: candidate.size }) }) }
      catch { throw new Error('Could not reach the media backend. Check VITE_SIGNALING_URL and the signaling origin allowlist.') }
      if (!response.ok) throw new Error(await responseError(response, 'Upload authorization failed'))
      const result = await response.json() as Partial<UploadAuthorization>
      if (!result.uploadUrl || !result.objectKey || !result.publicUrl) throw new Error('Upload authorization response is incomplete.')
      return result as UploadAuthorization
    },
    async upload(candidate, uploadUrl) {
      let response: Response
      try { response = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': candidate.type }, body: candidate }) }
      catch { throw new Error('Could not upload directly to R2. Check the bucket CORS settings.') }
      if (!response.ok) throw new Error(await responseError(response, 'Direct R2 upload failed'))
    },
    async insert(row) {
      const { data, error } = await client.from('media_assets').insert(row).select('*').single()
      if (error || !data) throw new Error(error?.message || 'Media metadata insert returned no row.')
      return data as MediaAsset
    },
    cleanup: objectKey => deleteR2Object(objectKey, accessToken),
  })
}

export async function deleteMediaAsset(asset: MediaAsset, usageCount: number) {
  const client = supabase
  if (!client) throw new Error('Supabase is not configured.')
  const { accessToken } = await currentSession()
  return deleteUnusedMediaAsset(asset, usageCount, {
    deleteObject: objectKey => deleteR2Object(objectKey, accessToken),
    async deleteMetadata(assetId) {
      const { error } = await client.from('media_assets').delete().eq('id', assetId)
      if (error) throw new Error(error.message)
    },
  })
}
