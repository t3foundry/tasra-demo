import { createHash, createHmac } from 'node:crypto'

export type DemoVideoId = 'department-signing' | 'send-encrypted-email-attachment'

const s3Host = 's3.eu-west-1.filonecontent.com'
const s3Region = 'eu-west-1'
const s3Service = 's3'

const objectKeys: Record<DemoVideoId, string> = {
  'department-signing': 'tasra-videos/department-signing.mp4',
  'send-encrypted-email-attachment': 'tasra-videos/send-encrypted-email-attachment.mp4',
}

/** Percent-encode a value the way AWS SigV4 expects (RFC 3986). */
function awsUriEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  )
}

function sign(key: string | Buffer, message: string): Buffer {
  return createHmac('sha256', key).update(message).digest()
}

/**
 * Build a browser-usable presigned GET URL for one S3 object. The signing
 * credentials are read from the server environment only and never reach the
 * browser.
 */
function presignGetUrl(objectKey: string, expiresSeconds: number): string {
  const accessKey = process.env.AWS_ACCESS_KEY_ID
  const secretKey = process.env.AWS_SECRET_ACCESS_KEY
  if (!accessKey || !secretKey) {
    throw new Error(
      'S3 signing credentials are missing (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)',
    )
  }

  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '')
  const dateStamp = amzDate.slice(0, 8)
  const credentialScope = `${dateStamp}/${s3Region}/${s3Service}/aws4_request`
  const credential = `${accessKey}/${credentialScope}`

  const canonicalUri =
    '/' + objectKey.split('/').map((segment) => awsUriEncode(segment)).join('/')

  const query: Array<[string, string]> = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', credential],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expiresSeconds)],
    ['X-Amz-SignedHeaders', 'host'],
  ]
  query.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

  const canonicalQuery = query
    .map(([key, value]) => `${awsUriEncode(key)}=${awsUriEncode(value)}`)
    .join('&')

  const canonicalRequest = [
    'GET',
    canonicalUri,
    canonicalQuery,
    `host:${s3Host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n')

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n')

  const signingKey = sign(
    sign(sign(sign(`AWS4${secretKey}`, dateStamp), s3Region), s3Service),
    'aws4_request',
  )
  const signature = sign(signingKey, stringToSign).toString('hex')

  const finalQuery =
    query.map(([key, value]) => `${awsUriEncode(key)}=${awsUriEncode(value)}`).join('&') +
    `&X-Amz-Signature=${signature}`

  return `https://${s3Host}${canonicalUri}?${finalQuery}`
}

/** Presigned URLs for the demo videos, valid for `expiresSeconds` (default 24h). */
export function demoVideoUrls(expiresSeconds = 86400): Record<DemoVideoId, string> {
  return Object.fromEntries(
    Object.entries(objectKeys).map(([id, key]) => [
      id,
      presignGetUrl(key, expiresSeconds),
    ]),
  ) as Record<DemoVideoId, string>
}
