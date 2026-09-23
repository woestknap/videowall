import { useEffect, useState } from 'react'
import { Admin } from './admin/Admin'
import { SignIn } from './admin/SignIn'
import { SceneEditorPage } from './editor/SceneEditorPage'
import { isConfigured, supabase } from './lib/supabase'
import { Player } from './player/Player'

export { EditorMedia } from './editor/SceneEditorPage'
export { ScenePreview } from './rendering/ScenePreview'

function App() {
  const player = new URLSearchParams(location.search).get('player') === '1'
  const editorSceneId = new URLSearchParams(location.search).get('editor')
  return player ? <Player /> : <AdminGate editorSceneId={editorSceneId} />
}

function AdminGate({ editorSceneId }: { editorSceneId: string | null }) {
  const [ready, setReady] = useState(false)
  const [signedIn, setSignedIn] = useState(false)
  useEffect(() => {
    if (!supabase) { setReady(true); return }
    void supabase.auth.getSession().then(({ data }) => { setSignedIn(Boolean(data.session)); setReady(true) })
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => setSignedIn(Boolean(session)))
    return () => listener.subscription.unsubscribe()
  }, [])
  if (!isConfigured) return <Admin />
  if (!ready) return <main className="player-message">Loading Videowall…</main>
  return signedIn ? (editorSceneId ? <SceneEditorPage sceneId={editorSceneId} /> : <Admin />) : <SignIn />
}

export default App
