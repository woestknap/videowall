import { useEffect, useState, type DragEvent, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import {
  DEFAULT_PLAYLIST_DURATION_SECONDS,
  durationParts,
  durationSecondsFromParts,
  movePlaylistItem,
  movePlaylistItemToIndex,
  nextPlaylistPosition,
  playlistsForWall,
  sceneBelongsToPlaylist,
  scenesForWall,
  sortPlaylistItems,
} from '../lib/playlists'
import { formatPlaylistActivationRemaining, formatPlaylistRemaining, playlistActivationRemainingMs, playlistRemainingMs, playlistRuntimeLabel } from '../lib/playlistRuntime'
import type { Playlist, PlaylistItem, PlaylistRuntime, Scene } from '../types'

const playlistFields = 'id,wall_id,name,loop,loading_scene_id,created_at,updated_at'
const itemFields = 'id,playlist_id,scene_id,position,duration_seconds,created_at,updated_at'

function PlaylistItemEditor({ item, index, count, scene, busy, onDuration, onMove, onMoveTo, onRemove }: {
  item: PlaylistItem
  index: number
  count: number
  scene?: Scene
  busy: boolean
  onDuration: (item: PlaylistItem, durationSeconds: number) => Promise<boolean>
  onMove: (itemId: string, direction: -1 | 1) => void
  onMoveTo: (itemId: string, index: number) => void
  onRemove: (item: PlaylistItem) => void
}) {
  const initial = durationParts(item.duration_seconds)
  const [minutes, setMinutes] = useState(initial.minutes)
  const [seconds, setSeconds] = useState(initial.seconds)
  const [error, setError] = useState('')

  useEffect(() => {
    const next = durationParts(item.duration_seconds)
    setMinutes(next.minutes); setSeconds(next.seconds); setError('')
  }, [item.duration_seconds])

  async function saveDuration() {
    const duration = durationSecondsFromParts(minutes, seconds)
    if (duration === null) return setError('Duration must be at least one second using whole numbers.')
    if (duration === item.duration_seconds) {
      const normalized = durationParts(duration)
      setMinutes(normalized.minutes); setSeconds(normalized.seconds); setError('')
      return
    }
    if (await onDuration(item, duration)) {
      const normalized = durationParts(duration)
      setMinutes(normalized.minutes); setSeconds(normalized.seconds); setError('')
    }
  }

  function startDrag(event: DragEvent<HTMLLIElement>) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', item.id)
  }

  return <li className={`dashboard-playlist-item ${scene ? '' : 'has-error'}`} draggable={!busy} onDragStart={startDrag} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); onMoveTo(event.dataTransfer.getData('text/plain'), index) }}>
    <span className="dashboard-playlist-item-position" aria-hidden="true">{index + 1}</span>
    <div className="dashboard-playlist-item-main"><strong>{scene?.name ?? 'Scene unavailable'}</strong><small>{scene ? 'Drag this row or use the move buttons.' : 'This item references missing content.'}</small></div>
    <div className="dashboard-playlist-duration" aria-label={`Duration for ${scene?.name ?? 'unavailable scene'}`}><label>Minutes<input type="number" min="0" step="1" value={minutes} disabled={busy} onChange={event => setMinutes(Number(event.target.value))} /></label><label>Seconds<input type="number" min="0" step="1" value={seconds} disabled={busy} onChange={event => setSeconds(Number(event.target.value))} /></label><button className="sm-button sm-button-secondary" disabled={busy} onClick={() => void saveDuration()}>Save duration</button>{error && <small className="dashboard-playlist-item-error" role="alert">{error}</small>}</div>
    <div className="dashboard-playlist-item-actions"><button className="sm-button sm-button-secondary" aria-label={`Move ${scene?.name ?? 'item'} up`} disabled={busy || index === 0} onClick={() => onMove(item.id, -1)}>Move up</button><button className="sm-button sm-button-secondary" aria-label={`Move ${scene?.name ?? 'item'} down`} disabled={busy || index === count - 1} onClick={() => onMove(item.id, 1)}>Move down</button><button className="sm-button sm-button-danger" disabled={busy} onClick={() => onRemove(item)}>Remove</button></div>
  </li>
}

export function PlaylistManager({ wallId, scenes, onNotice, onRuntimeChange }: { wallId: string; scenes: Scene[]; onNotice: (message: string) => void; onRuntimeChange: (runtime: PlaylistRuntime | null) => void }) {
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [items, setItems] = useState<PlaylistItem[]>([])
  const [selectedPlaylistId, setSelectedPlaylistId] = useState('')
  const [newName, setNewName] = useState('')
  const [nameDraft, setNameDraft] = useState('')
  const [sceneToAdd, setSceneToAdd] = useState('')
  const [busy, setBusy] = useState(false)
  const [runtime, setRuntime] = useState<PlaylistRuntime | null>(null)
  const [clockNow, setClockNow] = useState(Date.now())
  const wallPlaylists = playlistsForWall(playlists, wallId)
  const wallScenes = scenesForWall(scenes, wallId)
  const selectedPlaylist = wallPlaylists.find(playlist => playlist.id === selectedPlaylistId)
  const selectedItems = sortPlaylistItems(items.filter(item => item.playlist_id === selectedPlaylistId))

  useEffect(() => {
    let cancelled = false
    setPlaylists([]); setItems([]); setSelectedPlaylistId(''); setSceneToAdd('')
    if (!supabase || !wallId) return () => { cancelled = true }
    void (async () => {
      const { data: playlistData, error: playlistError } = await supabase.from('playlists').select(playlistFields).eq('wall_id', wallId).order('created_at')
      if (cancelled) return
      if (playlistError) return onNotice(`Could not load playlists: ${playlistError.message}`)
      const loadedPlaylists = (playlistData ?? []) as Playlist[]
      setPlaylists(loadedPlaylists); setSelectedPlaylistId(loadedPlaylists[0]?.id ?? '')
      if (!loadedPlaylists.length) return
      const { data: itemData, error: itemError } = await supabase.from('playlist_items').select(itemFields).in('playlist_id', loadedPlaylists.map(playlist => playlist.id)).order('position').order('id')
      if (cancelled) return
      if (itemError) return onNotice(`Could not load playlist items: ${itemError.message}`)
      setItems((itemData ?? []) as PlaylistItem[])
    })()
    return () => { cancelled = true }
  }, [wallId, scenes.length, onNotice])

  useEffect(() => { setNameDraft(selectedPlaylist?.name ?? '') }, [selectedPlaylist?.id, selectedPlaylist?.name])

  useEffect(() => {
    let cancelled = false
    if (!supabase || !wallId) { setRuntime(null); onRuntimeChange(null); return () => { cancelled = true } }
    const client = supabase
    const refresh = async () => {
      const { data, error } = await client.rpc('get_playlist_runtime', { requested_wall_id: wallId })
      if (cancelled || error) return
      const next = data as PlaylistRuntime | null
      setRuntime(next); onRuntimeChange(next)
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), runtime && (runtime.phase === 'PREPARING' || runtime.phase === 'ARMED') ? 400 : 2000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [wallId, onRuntimeChange, runtime?.phase])

  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  function acceptRuntime(next: unknown) {
    if (!next || typeof next !== 'object') return
    const value = next as PlaylistRuntime
    setRuntime(value); onRuntimeChange(value)
  }

  async function runtimeAction(action: 'start' | 'pause' | 'resume' | 'next' | 'stop') {
    if (!supabase || !wallId || busy || (action === 'start' && !selectedPlaylist)) return
    setBusy(true)
    const request = action === 'start'
      ? supabase.rpc('start_playlist', { requested_wall_id: wallId, requested_playlist_id: selectedPlaylist!.id })
      : supabase.rpc(`${action}_playlist${action === 'next' ? '_item' : ''}`, { requested_wall_id: wallId, expected_generation: runtime?.generation, expected_sequence: runtime?.sequence })
    const { data, error } = await request
    setBusy(false)
    if (error) return onNotice(`Could not ${action} playlist: ${error.message}`)
    acceptRuntime(data)
    onNotice(action === 'start' ? `Playlist “${selectedPlaylist!.name}” started.` : `Playlist ${action} requested.`)
  }

  async function createPlaylist(event: FormEvent) {
    event.preventDefault()
    const name = newName.trim()
    if (!supabase || !wallId || !name || busy) return
    setBusy(true)
    const { data, error } = await supabase.from('playlists').insert({ wall_id: wallId, name }).select(playlistFields).single()
    setBusy(false)
    if (error) return onNotice(`Could not create playlist: ${error.message}`)
    const playlist = data as Playlist
    setPlaylists(current => [...current, playlist]); setSelectedPlaylistId(playlist.id); setNewName('')
    onNotice(`Playlist “${playlist.name}” created.`)
  }

  async function updatePlaylist(change: Partial<Pick<Playlist, 'name' | 'loop' | 'loading_scene_id'>>, successMessage?: string) {
    if (!supabase || !selectedPlaylist || busy) return
    setBusy(true)
    const { data, error } = await supabase.from('playlists').update(change).eq('id', selectedPlaylist.id).select(playlistFields).single()
    setBusy(false)
    if (error) return onNotice(`Could not update playlist: ${error.message}`)
    setPlaylists(current => current.map(playlist => playlist.id === selectedPlaylist.id ? data as Playlist : playlist))
    if (successMessage) onNotice(successMessage)
  }

  async function renamePlaylist() {
    const name = nameDraft.trim()
    if (name && selectedPlaylist && name !== selectedPlaylist.name) await updatePlaylist({ name }, 'Playlist renamed.')
  }

  async function setLoadingScene(sceneId: string) {
    if (!selectedPlaylist) return
    const scene = sceneId ? wallScenes.find(candidate => candidate.id === sceneId) : null
    if (sceneId && (!scene || !sceneBelongsToPlaylist(scene, selectedPlaylist))) return onNotice('Choose a loading scene from this playlist’s wall.')
    await updatePlaylist({ loading_scene_id: sceneId || null }, scene ? `Loading scene set to ${scene.name}.` : 'Loading scene cleared.')
  }

  async function deletePlaylist(playlist: Playlist) {
    if (!supabase || busy || !confirm(`Delete playlist “${playlist.name}”? Its scenes will not be deleted.`)) return
    setBusy(true)
    const { error } = await supabase.from('playlists').delete().eq('id', playlist.id)
    setBusy(false)
    if (error) return onNotice(`Could not delete playlist: ${error.message}`)
    const remaining = playlists.filter(candidate => candidate.id !== playlist.id)
    setPlaylists(remaining); setItems(current => current.filter(item => item.playlist_id !== playlist.id)); setSelectedPlaylistId(current => current === playlist.id ? remaining[0]?.id ?? '' : current)
    onNotice('Playlist deleted. Scenes and wall output were not changed.')
  }

  async function addItem() {
    if (!supabase || !selectedPlaylist || !sceneToAdd || busy) return
    const scene = wallScenes.find(candidate => candidate.id === sceneToAdd)
    if (!scene || !sceneBelongsToPlaylist(scene, selectedPlaylist)) return onNotice('Choose a scene from this playlist’s wall.')
    const playlistItems = items.filter(item => item.playlist_id === selectedPlaylist.id)
    setBusy(true)
    const { data, error } = await supabase.from('playlist_items').insert({ playlist_id: selectedPlaylist.id, scene_id: scene.id, position: nextPlaylistPosition(playlistItems), duration_seconds: DEFAULT_PLAYLIST_DURATION_SECONDS }).select(itemFields).single()
    setBusy(false)
    if (error) return onNotice(`Could not add scene: ${error.message}`)
    setItems(current => [...current, data as PlaylistItem]); onNotice(`${scene.name} added to ${selectedPlaylist.name}.`)
  }

  async function saveDuration(item: PlaylistItem, durationSeconds: number) {
    if (!supabase || busy) return false
    setBusy(true)
    const { data, error } = await supabase.from('playlist_items').update({ duration_seconds: durationSeconds }).eq('id', item.id).select(itemFields).single()
    setBusy(false)
    if (error) { onNotice(`Could not save duration: ${error.message}`); return false }
    setItems(current => current.map(candidate => candidate.id === item.id ? data as PlaylistItem : candidate)); onNotice('Playlist duration saved.')
    return true
  }

  async function persistOrder(ordered: PlaylistItem[]) {
    if (!supabase || !selectedPlaylist || busy || ordered.every((item, index) => selectedItems[index]?.id === item.id)) return
    setBusy(true)
    const { data, error } = await supabase.rpc('reorder_playlist_items', { requested_playlist_id: selectedPlaylist.id, ordered_item_ids: ordered.map(item => item.id) })
    setBusy(false)
    if (error) return onNotice(`Could not reorder playlist: ${error.message}`)
    setItems(current => [...current.filter(item => item.playlist_id !== selectedPlaylist.id), ...((data ?? []) as PlaylistItem[])]); onNotice('Playlist order saved.')
  }

  function moveItem(itemId: string, direction: -1 | 1) { void persistOrder(movePlaylistItem(selectedItems, itemId, direction)) }
  function moveItemTo(itemId: string, index: number) { if (itemId) void persistOrder(movePlaylistItemToIndex(selectedItems, itemId, index)) }

  async function removeItem(item: PlaylistItem) {
    if (!supabase || busy) return
    setBusy(true)
    const { error } = await supabase.from('playlist_items').delete().eq('id', item.id)
    setBusy(false)
    if (error) return onNotice(`Could not remove playlist item: ${error.message}`)
    setItems(current => current.filter(candidate => candidate.id !== item.id))
  }

  return <section className="dashboard-section dashboard-playlist-section" aria-labelledby="playlists-heading">
    <div className="dashboard-section-heading"><div><p className="eyebrow">SCENE SEQUENCES</p><h2 id="playlists-heading">Playlists</h2></div><p>Build and run synchronized scene sequences for this wall.</p></div>
    {!wallId ? <p className="dashboard-empty-state">Select a wall to manage playlists.</p> : <div className="dashboard-playlist-workspace">
      <form className="dashboard-playlist-create sm-card sm-card-alt" onSubmit={createPlaylist}><label className="sm-field"><span>New playlist name</span><input value={newName} maxLength={100} onChange={event => setNewName(event.target.value)} placeholder="Morning playlist" /></label><button className="sm-button" disabled={!newName.trim() || busy}>Create playlist</button></form>
      {!wallPlaylists.length ? <p className="dashboard-empty-state">No playlists yet. Create one to start building a scene sequence.</p> : <div className="dashboard-playlist-layout">
        <div className="dashboard-playlist-list">{wallPlaylists.map(playlist => { const itemCount = items.filter(item => item.playlist_id === playlist.id).length; const loadingScene = scenes.find(scene => scene.id === playlist.loading_scene_id); return <article className={`dashboard-playlist-card sm-card-alt ${playlist.id === selectedPlaylistId ? 'is-selected' : ''}`} key={playlist.id}><div><strong>{playlist.name}</strong><small>{itemCount} scene{itemCount === 1 ? '' : 's'} · Loop {playlist.loop ? 'on' : 'off'} · Loading: {loadingScene?.name ?? 'None'}</small></div><div><button className="sm-button sm-button-secondary" onClick={() => setSelectedPlaylistId(playlist.id)}>Manage</button><button className="sm-button sm-button-danger" disabled={busy} onClick={() => void deletePlaylist(playlist)}>Delete</button></div></article> })}</div>
        {selectedPlaylist && <article className="dashboard-playlist-manager sm-card">
          <div className="dashboard-playlist-runtime sm-card-alt" aria-live="polite"><div><p className="eyebrow">PLAYBACK</p><strong>{runtime && runtime.status !== 'STOPPED' ? `${runtime.playlist_name} · ${playlistRuntimeLabel(runtime)}` : 'Stopped'}</strong>{runtime && runtime.status !== 'STOPPED' && <small>{runtime.phase === 'PREPARING' ? `Preparing ${runtime.target_scene_name ?? 'next scene'} · ${runtime.ready_count}/${runtime.expected_count} players ready` : runtime.phase === 'ARMED' ? `Starts in ${formatPlaylistActivationRemaining(playlistActivationRemainingMs(runtime, clockNow))}` : `Scene ${runtime.current_index + 1} of ${runtime.item_count} · ${runtime.current_scene_name ?? 'Scene'} · ${formatPlaylistRemaining(playlistRemainingMs(runtime, clockNow))} remaining`}</small>}</div><div className="dashboard-playlist-runtime-actions">{!runtime || runtime.status === 'STOPPED' ? <button className="sm-button" disabled={busy || !selectedItems.length} onClick={() => void runtimeAction('start')}>Start</button> : runtime.status === 'PLAYING' ? <><button className="sm-button sm-button-secondary" disabled={busy} onClick={() => void runtimeAction('pause')}>Pause</button><button className="sm-button sm-button-secondary" disabled={busy} onClick={() => void runtimeAction('next')}>Next</button><button className="sm-button sm-button-danger" disabled={busy} onClick={() => void runtimeAction('stop')}>Stop</button></> : <><button className="sm-button sm-button-secondary" disabled={busy} onClick={() => void runtimeAction('resume')}>Resume</button><button className="sm-button sm-button-secondary" disabled={busy} onClick={() => void runtimeAction('next')}>Next</button><button className="sm-button sm-button-danger" disabled={busy} onClick={() => void runtimeAction('stop')}>Stop</button></>}</div></div>
          {runtime && runtime.status !== 'STOPPED' && <p className="dashboard-playlist-runtime-note">This run uses a pinned snapshot. Playlist edits apply the next time it starts.</p>}
          <div className="dashboard-playlist-settings"><label className="sm-field"><span>Playlist name</span><input value={nameDraft} maxLength={100} onChange={event => setNameDraft(event.target.value)} /></label><button className="sm-button sm-button-secondary" disabled={!nameDraft.trim() || nameDraft.trim() === selectedPlaylist.name || busy} onClick={() => void renamePlaylist()}>Save name</button><label className="dashboard-playlist-loop"><input type="checkbox" checked={selectedPlaylist.loop} disabled={busy} onChange={event => void updatePlaylist({ loop: event.target.checked })} /> Loop playlist</label><label className="sm-field dashboard-playlist-loading-scene"><span>Transition / loading scene</span><select value={selectedPlaylist.loading_scene_id ?? ''} disabled={busy} onChange={event => void setLoadingScene(event.target.value)}><option value="">None</option>{wallScenes.map(scene => <option key={scene.id} value={scene.id}>{scene.name}</option>)}</select><small>Shown while players prepare the next scene.</small></label></div>
          <div className="dashboard-playlist-add"><label className="sm-field"><span>Add scene</span><select value={sceneToAdd} disabled={!wallScenes.length || busy} onChange={event => setSceneToAdd(event.target.value)}><option value="">Select a scene</option>{wallScenes.map(scene => <option key={scene.id} value={scene.id}>{scene.name}</option>)}</select></label><button className="sm-button" disabled={!sceneToAdd || busy} onClick={() => void addItem()}>Add to end</button></div>
          {!wallScenes.length && <p className="dashboard-empty-state">Create a scene before adding items.</p>}
          {selectedItems.length ? <ol className="dashboard-playlist-items">{selectedItems.map((item, index) => <PlaylistItemEditor key={item.id} item={item} index={index} count={selectedItems.length} scene={scenes.find(candidate => candidate.id === item.scene_id)} busy={busy} onDuration={saveDuration} onMove={moveItem} onMoveTo={moveItemTo} onRemove={item => void removeItem(item)} />)}</ol> : <p className="dashboard-empty-state">No scenes in this playlist.</p>}
        </article>}
      </div>}
    </div>}
  </section>
}
