/**
 * src/utils/sigv4.js
 * Re-sign outgoing S3 requests to Supabase using AWS Signature V4.
 * Uses @aws-sdk/signature-v4 + @smithy/protocol-http.
 * All outgoing HTTP via undici (built-in Node 20).
 *
 * Exported:
 *   resignRequest(options) → { url, headers }
 *   proxyRequest(options)  → undici response (stream)
 */

import { SignatureV4 } from '@aws-sdk/signature-v4'
import { HttpRequest } from '@smithy/protocol-http'
import { Sha256 } from '@aws-crypto/sha256-js'
import { request as undiciRequest } from 'undici'

// Headers that must be stripped from incoming client request before re-signing
const STRIP_HEADERS = new Set([
  'authorization',
  'x-amz-security-token',
  'x-amz-date',
  'x-amz-credential',
  'x-amz-algorithm',
  'x-amz-signature',
  'x-amz-signed-headers',
  'host',
  'connection',
  'transfer-encoding',
  'expect',
  // Never forward client-side compression preferences; upstream may return
  // compressed error payloads that become unreadable when proxied.
  'accept-encoding',
  // Hop-by-hop / edge forwarding headers are frequently rewritten by reverse
  // proxies (Cloudflare/Caddy) and can break SigV4 when included in signing.
  'forwarded',
  'via',
  'cdn-loop',
  'x-real-ip',
])

const FORWARDED_HEADER_ALLOWLIST = new Set([
  // Internal trace header injected by this service.
  'x-forwarded-request-id',
])

function shouldStripHeader(headerName) {
  if (STRIP_HEADERS.has(headerName)) return true
  if (headerName.startsWith('cf-')) return true

  if (headerName.startsWith('x-forwarded-')
      && !FORWARDED_HEADER_ALLOWLIST.has(headerName)) {
    return true
  }

  return false
}

function joinEndpointPath(basePath = '/', requestPath = '/') {
  const normalizedBase = basePath && basePath !== '/'
    ? basePath.replace(/\/+$/, '')
    : ''
  const normalizedRequest = requestPath.startsWith('/')
    ? requestPath
    : `/${requestPath}`

  return `${normalizedBase}${normalizedRequest}`
}

function buildUpstreamTarget(account, path) {
  const endpointUrl = new URL(account.endpoint)
  const signedPath = joinEndpointPath(endpointUrl.pathname, path)
  const addressingStyle = String(account.addressing_style ?? 'path').toLowerCase()

  if (addressingStyle !== 'virtual') {
    return {
      endpointUrl,
      hostname: endpointUrl.hostname,
      path: signedPath,
    }
  }

  const segments = signedPath.split('/').filter(Boolean)
  const prefixSegments = endpointUrl.pathname.split('/').filter(Boolean)

  if (segments.length <= prefixSegments.length) {
    return {
      endpointUrl,
      hostname: endpointUrl.hostname,
      path: signedPath,
    }
  }

  const bucketSegmentIndex = prefixSegments.length
  const bucket = segments[bucketSegmentIndex]
  if (!bucket) {
    return {
      endpointUrl,
      hostname: endpointUrl.hostname,
      path: signedPath,
    }
  }

  const objectSegments = segments.slice(bucketSegmentIndex + 1)
  const virtualPath = `${endpointUrl.pathname.replace(/\/+$/, '')}/${objectSegments.join('/')}` || '/'

  return {
    endpointUrl,
    hostname: `${bucket}.${endpointUrl.hostname}`,
    path: virtualPath.startsWith('/') ? virtualPath : `/${virtualPath}`,
  }
}

/**
 * Re-sign an S3 request for a specific account.
 *
 * @param {object} options
 * @param {object} options.account        - { access_key_id, secret_key, endpoint, region, bucket }
 * @param {string} options.method         - HTTP method
 * @param {string} options.path           - URL path (e.g. '/bucket/key')
 * @param {object} [options.query]        - query string params as object
 * @param {object} [options.headers]      - incoming headers (will be stripped of AWS auth)
 * @param {Buffer|Uint8Array|null} [options.body] - body for signing (optional, used for hash)
 * @returns {Promise<{ url: string, headers: object }>}
 */
export async function resignRequest({ account, method, path, query = {}, headers = {}, body = null }) {
  const target = buildUpstreamTarget(account, path)
  const endpointUrl = target.endpointUrl
  const signedPath = target.path
  const host = endpointUrl.port ? `${target.hostname}:${endpointUrl.port}` : target.hostname

  // Build clean headers (strip AWS auth headers, keep relevant ones)
  const cleanHeaders = {}
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase()
    if (lower.startsWith('x-amz-checksum-')) continue
    if (!shouldStripHeader(lower)) {
      cleanHeaders[lower] = v
    }
  }
  cleanHeaders['host'] = host

  // Build query string
  const queryParams = {}
  for (const [k, v] of Object.entries(query)) {
    queryParams[k] = v
  }

  // Build the HttpRequest
  const httpRequest = new HttpRequest({
    method: method.toUpperCase(),
    protocol: endpointUrl.protocol,
    hostname: target.hostname,
    port: endpointUrl.port ? parseInt(endpointUrl.port, 10) : undefined,
    path: signedPath,
    query: queryParams,
    headers: cleanHeaders,
    body,
  })

  // Sign
  const signer = new SignatureV4({
    credentials: {
      accessKeyId:     account.access_key_id,
      secretAccessKey: account.secret_key,
    },
    region:  account.region || 'auto',
    service: 's3',
    sha256:  Sha256,
  })

  const signed = await signer.sign(httpRequest)

  // Build final URL
  const queryStr = Object.entries(signed.query ?? {})
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')

  const url = `${endpointUrl.protocol}//${host}${signedPath}${queryStr ? '?' + queryStr : ''}`

  return { url, headers: signed.headers }
}

/**
 * Make an outgoing request to Supabase using undici, with re-signed headers.
 * Returns the raw undici response (with body as a stream).
 *
 * @param {object} options
 * @param {object} options.account
 * @param {string} options.method
 * @param {string} options.path
 * @param {object} [options.query]
 * @param {object} [options.headers]
 * @param {import('stream').Readable|Buffer|null} [options.bodyStream] - for PUT/POST
 * @returns {Promise<import('undici').Dispatcher.ResponseData>}
 */
export async function proxyRequest({ account, method, path, query = {}, headers = {}, bodyStream = null }) {
  // For signing, we don't buffer the body — use UNSIGNED-PAYLOAD for streaming
  const headersForSign = { ...headers }

  // Use unsigned payload for streaming PUTs to avoid buffering
  const payloadSigningMode = String(account.payload_signing_mode ?? 'unsigned').toLowerCase()
  const useUnsignedPayload = payloadSigningMode !== 'signed'
    && bodyStream
    && (method === 'PUT' || method === 'POST')

  if (useUnsignedPayload) {
    headersForSign['x-amz-content-sha256'] = 'UNSIGNED-PAYLOAD'
  }

  const { url, headers: signedHeaders } = await resignRequest({
    account,
    method,
    path,
    query,
    headers: headersForSign,
    body: null,
  })

  // Override with unsigned payload header if streaming
  if (useUnsignedPayload) {
    signedHeaders['x-amz-content-sha256'] = 'UNSIGNED-PAYLOAD'
  }

  const requestOptions = {
    method: method.toUpperCase(),
    headers: signedHeaders,
  }

  if (bodyStream) {
    requestOptions.body = bodyStream
  }

  return undiciRequest(url, requestOptions)
}
