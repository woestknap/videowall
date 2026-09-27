function required(env, name) {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

function publicBaseUrl(value) {
  let parsed
  try { parsed = new URL(value) } catch { throw new Error('R2_PUBLIC_BASE_URL must be a valid URL.') }
  if (parsed.protocol !== 'https:') throw new Error('R2_PUBLIC_BASE_URL must use https:.')
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== '/')) {
    throw new Error('R2_PUBLIC_BASE_URL must be an origin URL without credentials, path, query, or fragment.')
  }
  return parsed.origin
}

export function loadMediaConfig(env = process.env) {
  const accountId = required(env, 'R2_ACCOUNT_ID')
  const accessKeyId = required(env, 'R2_ACCESS_KEY_ID')
  const secretAccessKey = required(env, 'R2_SECRET_ACCESS_KEY')
  const bucketName = required(env, 'R2_BUCKET_NAME')
  if (!/^[a-f0-9]{32}$/i.test(accountId)) throw new Error('R2_ACCOUNT_ID must be a 32-character Cloudflare account ID.')
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucketName)) {
    throw new Error('R2_BUCKET_NAME must be a valid R2 bucket name.')
  }
  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    bucketName,
    publicBaseUrl: publicBaseUrl(required(env, 'R2_PUBLIC_BASE_URL')),
  }
}
