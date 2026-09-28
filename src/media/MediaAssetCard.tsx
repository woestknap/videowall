import type { MediaAsset } from '../types'
import { formatDimensions, formatDuration, formatFileSize } from './mediaLibraryUtils'

export function MediaAssetCard({ asset, usageCount, mode, selectable, busy, onSelect, onDelete }: {
  asset: MediaAsset
  usageCount: number
  mode: 'manage' | 'picker'
  selectable: boolean
  busy: boolean
  onSelect?: (asset: MediaAsset) => void
  onDelete?: (asset: MediaAsset) => void
}) {
  const duration = formatDuration(asset.duration_seconds)
  return <article className={`media-asset-card ${selectable ? '' : 'is-incompatible'}`}>
    <div className="media-asset-preview screenmesh-workspace-grid">
      {asset.media_type === 'image'
        ? <img src={asset.thumbnail_url || asset.public_url} alt="" loading="lazy" />
        : asset.thumbnail_url ? <img src={asset.thumbnail_url} alt="" loading="lazy" /> : <span aria-hidden="true">▶</span>}
      <small>{asset.media_type}</small>
    </div>
    <div className="media-asset-body">
      <strong title={asset.name}>{asset.name}</strong>
      <span title={asset.original_filename}>{asset.original_filename}</span>
      <div className="media-asset-facts"><span>{formatFileSize(asset.size_bytes)}</span><span>{formatDimensions(asset.width, asset.height)}</span>{duration && <span>{duration}</span>}</div>
      <small>Used in {usageCount} scene{usageCount === 1 ? '' : 's'} · {new Date(asset.created_at).toLocaleDateString()}</small>
      {mode === 'picker' && <button disabled={!selectable || busy} onClick={() => onSelect?.(asset)}>{selectable ? 'Use this asset' : `Not compatible with this layer`}</button>}
      {mode === 'manage' && <button className="maintenance-action" disabled={usageCount > 0 || busy} title={usageCount > 0 ? 'Remove this asset from every scene before deleting it.' : 'Delete unused asset'} onClick={() => onDelete?.(asset)}>{usageCount > 0 ? 'In use — cannot delete' : 'Delete asset'}</button>}
    </div>
  </article>
}
