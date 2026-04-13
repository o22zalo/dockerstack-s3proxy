/**
 * test/utils.test.js
 * T4 verification — Utilities tests.
 *
 * Usage:
 *   PROXY_API_KEY=test \
 *   FIREBASE_RTDB_URL=https://dummy.firebaseio.com \
 *   FIREBASE_DB_SECRET=dummy \
 *   SQLITE_PATH=../../.docker-volumes/s3proxy-data/test-utils.db \
 *   node test/utils.test.js
 *
 * Expected output:
 *   ✅ resignRequest tạo header Authorization dạng AWS4-HMAC-SHA256
 *   ✅ withRetry: fn fail 2 lần rồi pass → gọi đúng 3 lần
 *   ✅ withRetry: fn trả 404 → không retry, throw ngay
 *   ✅ buildErrorXml('NoSuchKey','msg','req1') → valid XML có <Code>NoSuchKey</Code>
 *   ✅ sendAlert({ event:'storage_full'}) → không throw dù WEBHOOK_ALERT_URL=''
 */

import { mkdirSync } from 'fs'

process.env.PROXY_API_KEY = process.env.PROXY_API_KEY || 'test'
process.env.FIREBASE_RTDB_URL = process.env.FIREBASE_RTDB_URL || 'https://dummy.firebaseio.com'
process.env.FIREBASE_DB_SECRET = process.env.FIREBASE_DB_SECRET || 'dummy'
const TEST_DB_DIR = '../../.docker-volumes/s3proxy-data'
process.env.SQLITE_PATH = `${TEST_DB_DIR}/test-utils-dummy.db`
mkdirSync(TEST_DB_DIR, { recursive: true })

let passed = 0
let failed = 0

function ok(label) {
  console.log(`✅ ${label}`)
  passed++
}

function fail(label, err) {
  console.error(`❌ ${label}`)
  console.error(`   ${err?.message || err}`)
  failed++
}

// ─── Test: resignRequest ──────────────────────────────────────────────────────

async function testResignRequest() {
  try {
    const { resignRequest } = await import('../src/utils/sigv4.js')

    const account = {
      access_key_id: 'AKIATESTKEY123',
      secret_key:    'testSecretKey456abcdef',
      endpoint:      'https://testproject.supabase.co/storage/v1/s3',
      region:        'ap-southeast-1',
      bucket:        'test-bucket',
    }

    const { url, headers } = await resignRequest({
      account,
      method:  'PUT',
      path:    '/test-bucket/foo/bar.txt',
      headers: {
        'content-type':   'text/plain',
        'content-length': '11',
        'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
      },
    })

    if (!headers['authorization'] || !headers['authorization'].startsWith('AWS4-HMAC-SHA256')) {
      throw new Error(`Authorization header missing or wrong format: ${headers['authorization']}`)
    }

    if (headers['x-amz-content-sha256'] !== 'UNSIGNED-PAYLOAD') {
      throw new Error(`x-amz-content-sha256 not preserved: ${headers['x-amz-content-sha256']}`)
    }

    if (!headers['authorization'].includes('x-amz-content-sha256')) {
      throw new Error(`SignedHeaders missing x-amz-content-sha256: ${headers['authorization']}`)
    }

    if (!url.startsWith('https://testproject.supabase.co')) {
      throw new Error(`URL wrong: ${url}`)
    }

    if (url !== 'https://testproject.supabase.co/storage/v1/s3/test-bucket/foo/bar.txt') {
      throw new Error(`URL missing endpoint base path: ${url}`)
    }

    ok(`resignRequest tạo header Authorization va giu /storage/v1/s3 trong URL`)
  } catch (err) {
    fail('resignRequest Authorization header', err)
  }
}

async function testResignRequestVirtualHostedStyle() {
  try {
    const { resignRequest } = await import('../src/utils/sigv4.js')

    const account = {
      access_key_id: 'AKIATESTKEY123',
      secret_key: 'testSecretKey456abcdef',
      endpoint: 'https://s3.amazonaws.com',
      region: 'us-east-1',
      bucket: 'ignored-bucket-field',
      addressing_style: 'virtual',
    }

    const { url, headers } = await resignRequest({
      account,
      method: 'GET',
      path: '/mybucket/folder/object.txt',
      headers: {},
    })

    if (!url.startsWith('https://mybucket.s3.amazonaws.com/')) {
      throw new Error(`Virtual-hosted URL wrong: ${url}`)
    }

    if (headers.host !== 'mybucket.s3.amazonaws.com') {
      throw new Error(`Virtual-hosted host wrong: ${headers.host}`)
    }

    ok('resignRequest ho tro virtual-hosted style cho endpoint S3-compatible')
  } catch (err) {
    fail('resignRequest virtual-hosted style', err)
  }
}

async function testResignRequestVirtualHostedWithPort() {
  try {
    const { resignRequest } = await import('../src/utils/sigv4.js')

    const account = {
      access_key_id: 'AKIATESTKEY123',
      secret_key: 'testSecretKey456abcdef',
      endpoint: 'http://127.0.0.1:9000',
      region: 'us-east-1',
      bucket: 'ignored-bucket-field',
      addressing_style: 'virtual',
    }

    const { url, headers } = await resignRequest({
      account,
      method: 'GET',
      path: '/mybucket/folder/object.txt',
      headers: {
        'x-amz-checksum-sha256': 'abc123',
      },
    })

    if (!url.startsWith('http://mybucket.127.0.0.1:9000/')) {
      throw new Error(`Virtual-hosted URL with port wrong: ${url}`)
    }

    if (headers.host !== 'mybucket.127.0.0.1:9000') {
      throw new Error(`Virtual-hosted host with port wrong: ${headers.host}`)
    }

    if (headers.authorization.includes('x-amz-checksum-sha256')) {
      throw new Error(`SignedHeaders should not include x-amz-checksum-sha256: ${headers.authorization}`)
    }

    ok('resignRequest virtual-hosted style giu port va loai checksum headers khi sign')
  } catch (err) {
    fail('resignRequest virtual-hosted style with port', err)
  }
}

async function testResignRequestStripsProxyForwardedHeaders() {
  try {
    const { resignRequest } = await import('../src/utils/sigv4.js')

    const account = {
      access_key_id: 'AKIATESTKEY123',
      secret_key: 'testSecretKey456abcdef',
      endpoint: 'https://testproject.supabase.co/storage/v1/s3',
      region: 'ap-southeast-1',
      bucket: 'test-bucket',
    }

    const { headers } = await resignRequest({
      account,
      method: 'PUT',
      path: '/test-bucket/object.txt',
      headers: {
        'content-type': 'text/plain',
        'content-length': '4',
        'accept-encoding': 'gzip, deflate',
        'x-forwarded-for': '203.0.113.10',
        'x-forwarded-host': 'example.com',
        'x-forwarded-proto': 'https',
        'x-forwarded-request-id': 'trace-123',
        'cf-ray': 'abc',
        'cf-connecting-ip': '203.0.113.10',
      },
    })

    if (headers['accept-encoding']) {
      throw new Error('accept-encoding should be stripped before signing')
    }
    if (headers['x-forwarded-for']) {
      throw new Error('x-forwarded-for should be stripped before signing')
    }
    if (headers['x-forwarded-host']) {
      throw new Error('x-forwarded-host should be stripped before signing')
    }
    if (headers['cf-ray']) {
      throw new Error('cf-ray should be stripped before signing')
    }
    if (headers['cf-connecting-ip']) {
      throw new Error('cf-connecting-ip should be stripped before signing')
    }
    if (headers['x-forwarded-request-id'] !== 'trace-123') {
      throw new Error('x-forwarded-request-id should be preserved')
    }

    const authHeader = headers.authorization || ''
    const signedHeadersMatch = authHeader.match(/SignedHeaders=([^,]+)/)
    if (!signedHeadersMatch) {
      throw new Error(`Unable to parse SignedHeaders from Authorization: ${authHeader}`)
    }

    const signedHeaders = signedHeadersMatch[1].split(';')
    for (const forbidden of ['accept-encoding', 'x-forwarded-for', 'x-forwarded-host', 'cf-ray']) {
      if (signedHeaders.includes(forbidden)) {
        throw new Error(`${forbidden} unexpectedly present in SignedHeaders: ${authHeader}`)
      }
    }
    if (!signedHeaders.includes('x-forwarded-request-id')) {
      throw new Error(`SignedHeaders missing x-forwarded-request-id: ${authHeader}`)
    }

    ok('resignRequest strip proxy/CDN headers de tranh SignatureDoesNotMatch tu upstream')
  } catch (err) {
    fail('resignRequest strip proxy/CDN headers', err)
  }
}

// ─── Test: withRetry success after 2 fails ───────────────────────────────────

async function testWithRetryPass() {
  try {
    const { withRetry } = await import('../src/utils/retry.js')

    let callCount = 0
    let retryCount = 0

    const result = await withRetry(
      async () => {
        callCount++
        if (callCount < 3) {
          const err = new Error('temporary error')
          err.statusCode = 503
          throw err
        }
        return 'success'
      },
      {
        maxAttempts: 3,
        baseDelayMs: 10,
        onRetry: (attempt) => { retryCount++ },
      }
    )

    if (result === 'success' && callCount === 3 && retryCount === 2) {
      ok(`withRetry: fn fail 2 lần rồi pass → gọi đúng 3 lần`)
    } else {
      fail('withRetry retry logic', new Error(`callCount=${callCount}, retryCount=${retryCount}, result=${result}`))
    }
  } catch (err) {
    fail('withRetry retry logic', err)
  }
}

// ─── Test: withRetry no retry on 404 ─────────────────────────────────────────

async function testWithRetryNo4xx() {
  try {
    const { withRetry } = await import('../src/utils/retry.js')

    let callCount = 0

    try {
      await withRetry(
        async () => {
          callCount++
          const err = new Error('not found')
          err.statusCode = 404
          throw err
        },
        { maxAttempts: 3, baseDelayMs: 10 }
      )
      fail('withRetry: fn trả 404 → không retry', new Error('Should have thrown'))
    } catch (err) {
      if (err.statusCode === 404 && callCount === 1) {
        ok(`withRetry: fn trả 404 → không retry, throw ngay`)
      } else {
        fail('withRetry: fn trả 404 → không retry', new Error(`callCount=${callCount}, statusCode=${err.statusCode}`))
      }
    }
  } catch (err) {
    fail('withRetry no retry on 404', err)
  }
}

// ─── Test: buildErrorXml ──────────────────────────────────────────────────────

async function testBuildErrorXml() {
  try {
    const { buildErrorXml } = await import('../src/utils/s3Xml.js')

    const xml = buildErrorXml('NoSuchKey', 'The key does not exist', 'req1')

    if (!xml.includes('<?xml') || !xml.includes('<Code>NoSuchKey</Code>') || !xml.includes('req1')) {
      throw new Error(`XML invalid: ${xml}`)
    }

    ok(`buildErrorXml('NoSuchKey','msg','req1') → valid XML có <Code>NoSuchKey</Code>`)
  } catch (err) {
    fail('buildErrorXml', err)
  }
}

async function testListAndBucketXmlCompatibility() {
  try {
    const {
      buildListBucketResult,
      buildGetBucketLocationResult,
      buildGetBucketVersioningResult,
    } = await import('../src/utils/s3Xml.js')

    const xml = buildListBucketResult('demo', [{ key: 'folder/a&b.txt', size: 1 }], {
      prefix: 'folder/',
      delimiter: '/',
      encodingType: 'url',
    })

    if (!xml.includes('<EncodingType>url</EncodingType>')) {
      throw new Error(`Missing EncodingType: ${xml}`)
    }
    if (!xml.includes('<Key>folder%2Fa%26b.txt</Key>')) {
      throw new Error(`Key is not URL encoded: ${xml}`)
    }

    const locationXml = buildGetBucketLocationResult('')
    if (!locationXml.includes('<LocationConstraint')) {
      throw new Error(`Invalid location xml: ${locationXml}`)
    }

    const versioningXml = buildGetBucketVersioningResult('')
    if (!versioningXml.includes('<VersioningConfiguration')) {
      throw new Error(`Invalid versioning xml: ${versioningXml}`)
    }

    ok('s3Xml ho tro encoding-type=url va canned response cho location/versioning')
  } catch (err) {
    fail('s3Xml list encoding/location/versioning', err)
  }
}

// ─── Test: sendAlert no-throw ─────────────────────────────────────────────────

async function testSendAlert() {
  try {
    const { sendAlert } = await import('../src/utils/webhook.js')

    // Should not throw even if WEBHOOK_ALERT_URL is empty
    sendAlert({ event: 'storage_full', detail: 'test alert' })
    ok(`sendAlert({ event:'storage_full'}) → không throw dù WEBHOOK_ALERT_URL=''`)
  } catch (err) {
    fail('sendAlert no-throw', err)
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('─'.repeat(60))
  console.log('T4 — Utilities Tests')
  console.log('─'.repeat(60))

  await testResignRequest()
  await testResignRequestVirtualHostedStyle()
  await testResignRequestVirtualHostedWithPort()
  await testResignRequestStripsProxyForwardedHeaders()
  await testWithRetryPass()
  await testWithRetryNo4xx()
  await testBuildErrorXml()
  await testListAndBucketXmlCompatibility()
  await testSendAlert()

  console.log('─'.repeat(60))
  console.log(`Results: ${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main()


