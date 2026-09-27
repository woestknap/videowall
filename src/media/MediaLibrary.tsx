import { useEffect, useMemo, useState, type ChangeEvent, type ReactNode } from 'react'
import { supabase } from '../lib/supabase'
import type { MediaAsset, Scene, SceneLayer } from '../types'
import { deleteMediaAsset, uploadMediaAsset } from './mediaApi'
import { assetMatchesLayerType, filterAndSortMedia, mediaTypeForMime, mediaUsageCounts, type MediaFilter, type MediaSort } from './mediaLibraryUtils'
import { MediaAssetCard } from './MediaAssetCard'

type MediaLibraryProps = {
  mode: 'manage' | 'picker'
  allowedType?: Extract<SceneLayer['type'], 'image' | 'video'>
  onSelect?: (asset: MediaAsset) => void
  onClose?: () => void
}

export function MediaLibrary({ mode, allowedType, onSelect, onClose }: MediaLibraryProps) {
  const [assets, setAssets] = useState<MediaAsset[]>([])
  const [scenes, setScenes] = useState<Array<Pick<Scene, 'id' | 'layers'>>>([])
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<MediaFilter>(allowedType ?? 'all')
  const [sort, setSort] = useState<MediaSort>('newest')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    if (!supabase) { setError('Supabase is not configured.'); setLoading(false); return }
    void Promise.all([
      supabase.from('media_assets').select('*').order('created_at', { ascending: false }),
      supabase.from('scenes').select('id,layers'),
    ]).then(([assetResult, sceneResult]) => {
      if (cancelled) return
      const firstError = assetResult.error || sceneResult.error
      if (firstError) setError(firstError.message)
      else {
        setAssets((assetResult.data ?? []) as MediaAsset[])
        setScenes((sceneResult.data ?? []).map(scene => ({ id: scene.id, layers: scene.layers as SceneLayer[] })))
      }
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  const usage = useMemo(() => mediaUsageCounts(scenes), [scenes])
  const visible = useMemo(() => filterAndSortMedia(assets, search, allowedType ?? filter, sort), [assets, search, filter, sort, allowedType])

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (allowedType && mediaTypeForMime(file.type) !== allowedType) {
      setMessage('')
      setError(`Choose a ${allowedType} file for this ${allowedType} layer.`)
      return
    }
    setBusy(true); setError(''); setMessage(`Uploading ${file.name}…`)
    try {
      const asset = await uploadMediaAsset(file)
      setAssets(current => [asset, ...current.filter(item => item.id !== asset.id)])
      setMessage(`${asset.name} was uploaded and added to the library.`)
    } catch (reason) {
      setMessage('')
      setError(reason instanceof Error ? reason.message : 'Media upload failed.')
    } finally { setBusy(false) }
  }

  async function remove(asset: MediaAsset) {
    const count = usage.get(asset.id) ?? 0
    if (count > 0) { setError(`“${asset.name}” is used in ${count} scene${count === 1 ? '' : 's'} and cannot be deleted.`); return }
    if (!confirm(`Delete “${asset.name}” from R2 and the media library? This cannot be undone.`)) return
    setBusy(true); setError(''); setMessage(`Deleting ${asset.name}…`)
    try {
      if (!supabase) throw new Error('Supabase is not configured.')
      const { data, error: sceneError } = await supabase.from('scenes').select('id,layers')
      if (sceneError) throw new Error(`Could not verify current scene usage: ${sceneError.message}`)
      const freshScenes = (data ?? []).map(scene => ({ id: scene.id, layers: scene.layers as SceneLayer[] }))
      const freshCount = mediaUsageCounts(freshScenes).get(asset.id) ?? 0
      setScenes(freshScenes)
      await deleteMediaAsset(asset, freshCount)
      setAssets(current => current.filter(item => item.id !== asset.id))
      setMessage(`${asset.name} was deleted.`)
    } catch (reason) {
      setMessage('')
      setError(reason instanceof Error ? reason.message : 'Media deletion failed.')
    } finally { setBusy(false) }
  }

  const body: ReactNode = <>
    <div className="media-library-upload-row">
      <label className={`upload-button ${busy ? 'is-disabled' : ''}`}>Upload new<input disabled={busy} type="file" accept={allowedType === 'video' ? 'video/mp4' : allowedType === 'image' ? 'image/jpeg,image/png,image/webp' : 'image/jpeg,image/png,image/webp,video/mp4'} onChange={event => void upload(event)} /></label>
    </div>
    <div className="media-library-toolbar">
      <label>Search<input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Name or filename" /></label>
      <label>Type<select value={allowedType ?? filter} disabled={Boolean(allowedType)} onChange={event => setFilter(event.target.value as MediaFilter)}><option value="all">All</option><option value="image">Images</option><option value="video">Videos</option></select></label>
      <label>Sort<select value={sort} onChange={event => setSort(event.target.value as MediaSort)}><option value="newest">Newest</option><option value="name">Name</option><option value="oldest">Oldest</option></select></label>
    </div>
    {message && <p className="media-library-message" role="status">{message}</p>}
    {error && <p className="media-library-error" role="alert">{error}</p>}
    {loading ? <p className="media-library-empty">Loading media library…</p>
      : !assets.length ? <p className="media-library-empty">No media assets yet. Upload a playback-ready image or MP4.</p>
        : !visible.length ? <p className="media-library-empty">No assets match this search and filter.</p>
          : <div className="media-asset-grid">{visible.map(asset => <MediaAssetCard key={asset.id} asset={asset} usageCount={usage.get(asset.id) ?? 0} mode={mode} selectable={!allowedType || assetMatchesLayerType(asset, allowedType)} busy={busy} onSelect={candidate => onSelect?.(candidate)} onDelete={candidate => void remove(candidate)} />)}</div>}
  </>

  if (mode === 'picker') return <div className="media-library-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose?.() }}><section className="media-library-dialog" role="dialog" aria-modal="true" aria-labelledby="media-library-picker-title"><div className="panel-heading"><div><p className="eyebrow">REUSABLE MEDIA</p><h2 id="media-library-picker-title">Choose {allowedType}</h2></div><button className="secondary" onClick={onClose}>Close</button></div>{body}</section></div>
  return <article className="panel media-library-panel"><div className="panel-heading"><div><p className="eyebrow">REUSABLE PLAYBACK ASSETS</p><h2>Media Library</h2></div><span>{assets.length} assets</span></div>{body}</article>
}
