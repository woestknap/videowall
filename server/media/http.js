const MAX_JSON_BODY_BYTES = 16 * 1024

function allowCorsOrigin(request, response, allowedOrigins) {
  const origin = request.headers.origin
  if (!origin) return true
  if (!allowedOrigins.includes(origin)) return false
  response.setHeader('Access-Control-Allow-Origin', origin)
  response.setHeader('Vary', 'Origin')
  return true
}

function setPreflightHeaders(response) {
  response.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS')
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  response.setHeader('Access-Control-Max-Age', '3600')
}

function json(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
  response.end(body)
}

function accessToken(request) {
  const header = request.headers.authorization
  const match = typeof header === 'string' ? /^Bearer ([^\s]+)$/.exec(header) : null
  return match?.[1] ?? null
}

async function readJson(request) {
  let size = 0
  const chunks = []
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_JSON_BODY_BYTES) throw new TypeError('Request body is too large.')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new TypeError('Request body must be valid JSON.')
  }
}

export function createMediaHttpHandler({ auth, mediaStore, allowedOrigins = [] }) {
  return async function handleRequest(request, response) {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const isMediaRoute = url.pathname === '/api/media' || url.pathname.startsWith('/api/media/')

    if (isMediaRoute && !allowCorsOrigin(request, response, allowedOrigins)) {
      json(response, 403, { error: 'Origin is not allowed.' })
      return
    }
    if (request.method === 'OPTIONS' && isMediaRoute) {
      setPreflightHeaders(response)
      response.writeHead(204)
      response.end()
      return
    }
    if (!isMediaRoute) {
      response.writeHead(426, { 'Content-Type': 'text/plain; charset=utf-8', Upgrade: 'websocket' })
      response.end('Upgrade Required')
      return
    }
    if (!((request.method === 'POST' && url.pathname === '/api/media/upload-url') || (request.method === 'DELETE' && url.pathname === '/api/media/object'))) {
      json(response, 404, { error: 'Not found.' })
      return
    }

    try {
      const token = accessToken(request)
      if (!token || !await auth.authenticateEditor(token)) {
        json(response, 401, { error: 'A valid editor access token is required.' })
        return
      }
      const body = await readJson(request)
      if (request.method === 'POST') {
        const authorization = await mediaStore.createUploadAuthorization(body)
        json(response, 200, authorization)
      } else {
        await mediaStore.deleteObject(body?.objectKey)
        response.writeHead(204)
        response.end()
      }
    } catch (error) {
      if (error instanceof TypeError) json(response, 400, { error: error.message })
      else {
        console.error('Media API operation failed.', error)
        json(response, 500, { error: 'Media operation failed.' })
      }
    }
  }
}
