import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { manualR2Upload, type ManualR2UploadResult } from '../lib/manualR2Upload'

// Temporary MEDIA-01A.1 developer probe. Delete this component and its Admin import in MEDIA-01B.
export function R2UploadTestPanel() {
  const [file, setFile] = useState<File | null>(null)
  const [result, setResult] = useState<ManualR2UploadResult | null>(null)
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState(false)

  async function upload() {
    if (!file || !supabase) return
    setUploading(true)
    setError('')
    setResult(null)
    try {
      const signalingUrl = import.meta.env.VITE_SIGNALING_URL
      if (!signalingUrl) throw new Error('VITE_SIGNALING_URL is not configured.')
      const { data, error: sessionError } = await supabase.auth.getSession()
      if (sessionError || !data.session?.access_token) throw new Error('Sign in again before testing the upload.')
      setResult(await manualR2Upload(file, data.session.access_token, signalingUrl))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'R2 upload test failed.')
    } finally {
      setUploading(false)
    }
  }

  return <article className="panel r2-upload-test-panel" aria-labelledby="r2-upload-test-title">
    <div className="panel-heading"><div><p className="eyebrow">TEMPORARY DEVELOPER TOOL</p><h2 id="r2-upload-test-title">Test R2 upload</h2></div><span>MEDIA-01A.1</span></div>
    <p>Uploads one playback-ready file directly to R2. It does not create a media asset or change any scene.</p>
    <div className="r2-upload-test-controls">
      <input aria-label="R2 test file" type="file" accept="image/jpeg,image/png,image/webp,video/mp4" onChange={(event) => { setFile(event.target.files?.[0] ?? null); setResult(null); setError('') }} />
      <button disabled={!file || uploading} onClick={() => void upload()}>{uploading ? 'Uploading…' : 'Test R2 upload'}</button>
    </div>
    {file && !result && <small>Selected: {file.name} · {file.size.toLocaleString()} bytes · {file.type || 'unknown MIME type'}</small>}
    {error && <p className="r2-upload-test-error" role="alert">Failed: {error}</p>}
    {result && <dl className="r2-upload-test-result" aria-label="R2 upload succeeded">
      <div><dt>Status</dt><dd>Upload succeeded</dd></div>
      <div><dt>Object key</dt><dd><code>{result.objectKey}</code></dd></div>
      <div><dt>Public URL</dt><dd><a href={result.publicUrl} target="_blank" rel="noreferrer">{result.publicUrl}</a></dd></div>
      <div><dt>File size</dt><dd>{result.sizeBytes.toLocaleString()} bytes</dd></div>
      <div><dt>MIME type</dt><dd>{result.mimeType}</dd></div>
    </dl>}
  </article>
}
