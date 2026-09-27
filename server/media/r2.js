import { randomUUID } from 'node:crypto'
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

export const MAX_MEDIA_UPLOAD_BYTES = 500 * 1024 * 1024
export const UPLOAD_URL_TTL_SECONDS = 300

const MIME_EXTENSIONS = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['video/mp4', 'mp4'],
])

const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const MEDIA_OBJECT_KEY = new RegExp(`^media/${UUID_PATTERN}/[A-Za-z0-9][A-Za-z0-9._-]{0,100}$`)

export function validateUploadRequest({ filename, mimeType, sizeBytes } = {}) {
  if (typeof filename !== 'string' || !filename.trim() || filename.length > 255 || /[\\/\u0000-\u001f\u007f]/.test(filename)) {
    throw new TypeError('filename must be a safe file name of at most 255 characters.')
  }
  if (!MIME_EXTENSIONS.has(mimeType)) throw new TypeError('mimeType is not supported.')
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_MEDIA_UPLOAD_BYTES) {
    throw new TypeError(`sizeBytes must be between 1 and ${MAX_MEDIA_UPLOAD_BYTES}.`)
  }
  return { filename: filename.trim(), mimeType, sizeBytes }
}

export function safeMediaFilename(filename, mimeType) {
  const validated = validateUploadRequest({ filename, mimeType, sizeBytes: 1 })
  const extension = MIME_EXTENSIONS.get(mimeType)
  const withoutExtension = validated.filename.replace(/\.[^.]*$/, '')
  const stem = withoutExtension
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'upload'
  return `${stem}.${extension}`
}

export function createMediaObjectKey({ filename, mimeType, id = randomUUID() }) {
  if (!new RegExp(`^${UUID_PATTERN}$`).test(id)) throw new TypeError('id must be a version 4 UUID.')
  return `media/${id}/${safeMediaFilename(filename, mimeType)}`
}

export function isMediaObjectKey(objectKey) {
  return typeof objectKey === 'string' && MEDIA_OBJECT_KEY.test(objectKey)
}

export function publicMediaUrl(publicBaseUrl, objectKey) {
  if (!isMediaObjectKey(objectKey)) throw new TypeError('objectKey is outside the managed media namespace.')
  return `${publicBaseUrl.replace(/\/$/, '')}/${objectKey}`
}

export function createR2MediaStore(config, dependencies = {}) {
  const client = dependencies.client ?? new S3Client({
    region: 'auto',
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  })
  const sign = dependencies.sign ?? getSignedUrl
  const createId = dependencies.randomUUID ?? randomUUID

  return {
    async createUploadAuthorization(request) {
      const { filename, mimeType, sizeBytes } = validateUploadRequest(request)
      const objectKey = createMediaObjectKey({ filename, mimeType, id: createId() })
      const command = new PutObjectCommand({
        Bucket: config.bucketName,
        Key: objectKey,
        ContentType: mimeType,
        ContentLength: sizeBytes,
      })
      const uploadUrl = await sign(client, command, { expiresIn: UPLOAD_URL_TTL_SECONDS })
      return {
        uploadUrl,
        objectKey,
        publicUrl: publicMediaUrl(config.publicBaseUrl, objectKey),
        expiresIn: UPLOAD_URL_TTL_SECONDS,
      }
    },

    async deleteObject(objectKey) {
      if (!isMediaObjectKey(objectKey)) throw new TypeError('objectKey is outside the managed media namespace.')
      await client.send(new DeleteObjectCommand({ Bucket: config.bucketName, Key: objectKey }))
    },
  }
}
