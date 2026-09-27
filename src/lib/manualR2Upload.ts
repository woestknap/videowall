export type ManualR2UploadResult = {
  objectKey: string
  publicUrl: string
  sizeBytes: number
  mimeType: string
}

type UploadAuthorization = {
  uploadUrl: string
  objectKey: string
  publicUrl: string
}

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
  } catch {
    // The R2 response may be empty or XML; the status below remains useful.
  }
  return `${fallback} (${response.status} ${response.statusText || 'HTTP error'})`
}

// Temporary MEDIA-01A.1 verification helper. Remove with R2UploadTestPanel in MEDIA-01B.
export async function manualR2Upload(file: File, accessToken: string, signalingUrl: string, fetchRequest: typeof fetch = fetch): Promise<ManualR2UploadResult> {
  let authorizationResponse: Response
  try {
    authorizationResponse = await fetchRequest(`${signalingHttpOrigin(signalingUrl)}/api/media/upload-url`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, mimeType: file.type, sizeBytes: file.size }),
    })
  } catch {
    throw new Error('Could not reach the media backend. Check VITE_SIGNALING_URL and the signaling origin allowlist.')
  }
  if (!authorizationResponse.ok) throw new Error(await responseError(authorizationResponse, 'Upload authorization failed'))

  const authorization = await authorizationResponse.json() as Partial<UploadAuthorization>
  if (!authorization.uploadUrl || !authorization.objectKey || !authorization.publicUrl) throw new Error('Upload authorization response is incomplete.')

  let uploadResponse: Response
  try {
    uploadResponse = await fetchRequest(authorization.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': file.type },
      body: file,
    })
  } catch {
    throw new Error('Could not upload directly to R2. Check the bucket CORS origins, PUT method, and Content-Type header.')
  }
  if (!uploadResponse.ok) throw new Error(await responseError(uploadResponse, 'Direct R2 upload failed'))

  return { objectKey: authorization.objectKey, publicUrl: authorization.publicUrl, sizeBytes: file.size, mimeType: file.type }
}
