/**
 * test/server.test.js
 * Fastify route integration with a local fake S3 upstream.
 */

import { createServer } from 'http'
import { mkdirSync, existsSync, unlinkSync } from 'fs'

process.env.PROXY_API_KEY = process.env.PROXY_API_KEY || 'test'
process.env.FIREBASE_RTDB_URL = process.env.FIREBASE_RTDB_URL || 'https://dummy.firebaseio.com'
process.env.FIREBASE_DB_SECRET = process.env.FIREBASE_DB_SECRET || 'dummy'
process.env.ALLOW_INSECURE_SIGV4_KEY_EXTRACT = 'false'
const TEST_DB_DIR = '../../.docker-volumes/s3proxy-data'
process.env.SQLITE_PATH = `${TEST_DB_DIR}/test-server.db`
process.env.LOG_LEVEL = 'fatal'

const TEST_DB = process.env.SQLITE_PATH
mkdirSync(TEST_DB_DIR, { recursive: true })
for (const file of [TEST_DB, `${TEST_DB}-shm`, `${TEST_DB}-wal`]) {
  if (existsSync(file)) unlinkSync(file)
}

const Fastify = (await import('fastify')).default
const authPlugin = (await import('../src/plugins/auth.js')).default
const errorHandler = (await import('../src/plugins/errorHandler.js')).default
const healthRoutes = (await import('../src/routes/health.js')).default
const metricsRoutes = (await import('../src/routes/metrics.js')).default
const s3Routes = (await import('../src/routes/s3.js')).default
const { db, upsertAccount, upsertPublicBucket, getRoute, ROUTE_STATE } = await import('../src/db.js')
const { reloadAccountsFromSQLite } = await import('../src/accountPool.js')

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

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

async function startFakeS3() {
  const objects = new Map()
  const uploads = new Map()
  let uploadCounter = 0

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const parts = url.pathname.split('/').filter(Boolean)
    const bucket = parts[0] || ''
    const key = parts.slice(1).join('/')
    const objectId = `${bucket}/${key}`

    if (req.method === 'POST' && url.searchParams.has('uploads')) {
      const uploadId = `upload-${++uploadCounter}`
      uploads.set(uploadId, { bucket, key, parts: new Map() })
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/xml')
      res.end([
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<InitiateMultipartUploadResult>',
        `  <Bucket>${bucket}</Bucket>`,
        `  <Key>${key}</Key>`,
        `  <UploadId>${uploadId}</UploadId>`,
        '</InitiateMultipartUploadResult>',
      ].join('\n'))
      return
    }

    if (req.method === 'PUT' && url.searchParams.has('uploadId') && url.searchParams.has('partNumber')) {
      const uploadId = url.searchParams.get('uploadId')
      const partNumber = Number(url.searchParams.get('partNumber'))
      const upload = uploads.get(uploadId)
      if (!upload) {
        res.statusCode = 404
        res.end('missing upload')
        return
      }

      upload.parts.set(partNumber, await readBody(req))
      res.statusCode = 200
      res.setHeader('ETag', `"part-${partNumber}"`)
      res.end('')
      return
    }

    if (req.method === 'POST' && url.searchParams.has('uploadId')) {
      const uploadId = url.searchParams.get('uploadId')
      const upload = uploads.get(uploadId)
      if (!upload) {
        res.statusCode = 404
        res.end('missing upload')
        return
      }

      await readBody(req)
      const body = Buffer.concat([...upload.parts.entries()].sort((a, b) => a[0] - b[0]).map((entry) => entry[1]))
      objects.set(`${upload.bucket}/${upload.key}`, {
        body,
        contentType: 'application/octet-stream',
        lastModified: new Date().toUTCString(),
      })
      uploads.delete(uploadId)

      res.statusCode = 200
      res.setHeader('Content-Type', 'application/xml')
      res.setHeader('ETag', '"complete-etag"')
      res.end([
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<CompleteMultipartUploadResult>',
        `  <Location>/${upload.bucket}/${upload.key}</Location>`,
        `  <Bucket>${upload.bucket}</Bucket>`,
        `  <Key>${upload.key}</Key>`,
        '  <ETag>"complete-etag"</ETag>',
        '</CompleteMultipartUploadResult>',
      ].join('\n'))
      return
    }

    if (req.method === 'PUT') {
      const body = await readBody(req)
      objects.set(objectId, {
        body,
        contentType: req.headers['content-type'] || 'application/octet-stream',
        lastModified: new Date().toUTCString(),
      })
      res.statusCode = 200
      res.setHeader('ETag', '"put-etag"')
      res.end('')
      return
    }

    if (req.method === 'GET' && key === '') {
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/xml')
      res.end('<?xml version="1.0" encoding="UTF-8"?><ListBucketResult></ListBucketResult>')
      return
    }

    if (req.method === 'GET') {
      const object = objects.get(objectId)
      if (!object) {
        res.statusCode = 404
        res.end('missing object')
        return
      }
      res.statusCode = 200
      res.setHeader('Content-Type', object.contentType)
      res.setHeader('Content-Length', object.body.length)
      res.setHeader('Last-Modified', object.lastModified)
      res.setHeader('ETag', '"get-etag"')
      res.end(object.body)
      return
    }

    if (req.method === 'HEAD') {
      const object = objects.get(objectId)
      if (!object) {
        res.statusCode = 404
        res.end('')
        return
      }
      res.statusCode = 200
      res.setHeader('Content-Type', object.contentType)
      res.setHeader('Content-Length', object.body.length)
      res.setHeader('Last-Modified', object.lastModified)
      res.setHeader('ETag', '"head-etag"')
      res.end('')
      return
    }

    if (req.method === 'DELETE' && url.searchParams.has('uploadId')) {
      uploads.delete(url.searchParams.get('uploadId'))
      res.statusCode = 204
      res.end('')
      return
    }

    if (req.method === 'DELETE') {
      objects.delete(objectId)
      res.statusCode = 204
      res.end('')
      return
    }

    res.statusCode = 405
    res.end('method not allowed')
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  }
}

async function main() {
  console.log('─'.repeat(60))
  console.log('T5 - Server Routes Tests')
  console.log('─'.repeat(60))

  const upstream = await startFakeS3()
  const fastify = Fastify({ logger: false })

  try {
    upsertAccount({
      account_id: 'acc1',
      access_key_id: 'key-1',
      secret_key: 'secret-1',
      endpoint: upstream.endpoint,
      region: 'ap-southeast-1',
      bucket: 'internal-bucket',
      quota_bytes: 5_000_000_000,
      used_bytes: 0,
      active: 1,
      added_at: Date.now(),
    })
    reloadAccountsFromSQLite()

    fastify.decorate('config', { INSTANCE_ID: 'test-instance' })
    await fastify.register(authPlugin)
    await fastify.register(errorHandler)
    await fastify.register(healthRoutes)
    await fastify.register(metricsRoutes)
    await fastify.register(s3Routes, { prefix: '/' })

    const authHeaders = {
      'x-api-key': 'test',
      'content-type': 'text/plain',
    }

    try {
      const createBucketRes = await fastify.inject({
        method: 'PUT',
        url: '/mybucket',
        headers: { 'x-api-key': 'test' },
      })
      assert(createBucketRes.statusCode === 200, `CreateBucket status=${createBucketRes.statusCode}`)
      ok('PUT /mybucket -> 200 create logical bucket')
    } catch (err) {
      fail('PUT /mybucket', err)
    }

    try {
      const locationRes = await fastify.inject({
        method: 'GET',
        url: '/mybucket?location',
        headers: { 'x-api-key': 'test' },
      })
      assert(locationRes.statusCode === 200, `GetBucketLocation status=${locationRes.statusCode}`)
      assert(locationRes.payload.includes('<LocationConstraint'), 'GetBucketLocation missing XML root')
      ok('GET /mybucket?location -> 200 canned XML')
    } catch (err) {
      fail('GET /mybucket?location', err)
    }

    try {
      const versioningRes = await fastify.inject({
        method: 'GET',
        url: '/mybucket?versioning',
        headers: { 'x-api-key': 'test' },
      })
      assert(versioningRes.statusCode === 200, `GetBucketVersioning status=${versioningRes.statusCode}`)
      assert(versioningRes.payload.includes('<VersioningConfiguration'), 'GetBucketVersioning missing XML root')
      ok('GET /mybucket?versioning -> 200 canned XML')
    } catch (err) {
      fail('GET /mybucket?versioning', err)
    }

    try {
      const copyRes = await fastify.inject({
        method: 'PUT',
        url: '/mybucket/path/to/copied.txt',
        headers: {
          ...authHeaders,
          'x-amz-copy-source': '/mybucket/source.txt',
        },
      })
      assert(copyRes.statusCode === 501, `CopyObject status=${copyRes.statusCode}`)
      assert(copyRes.payload.includes('<Code>NotImplemented</Code>'), 'CopyObject should return NotImplemented')
      ok('PUT co x-amz-copy-source -> 501 NotImplemented')
    } catch (err) {
      fail('PUT x-amz-copy-source', err)
    }

    try {
      const putRes = await fastify.inject({
        method: 'PUT',
        url: '/mybucket/path/to/file.txt',
        headers: authHeaders,
        payload: 'hello world',
      })
      const stored = getRoute(Buffer.from('mybucket/path/to/file.txt').toString('base64url'))
      assert(putRes.statusCode === 200, `PUT status=${putRes.statusCode}`)
      assert(stored, 'route not stored')
      assert(stored.backend_key === 'mybucket/path/to/file.txt', `backend_key=${stored.backend_key}`)
      ok('PUT /mybucket/path/to/file.txt -> 200, route duoc luu')
    } catch (err) {
      fail('PUT /mybucket/path/to/file.txt', err)
    }

    try {
      upsertPublicBucket('mybucket', true)
      const publicPutRes = await fastify.inject({
        method: 'PUT',
        url: '/mybucket/path/public-image.png',
        headers: authHeaders,
        payload: 'image-bytes',
      })
      assert(publicPutRes.statusCode === 200, `PUT public bucket status=${publicPutRes.statusCode}`)
      const publicUrl = publicPutRes.headers['x-s3proxy-direct-url']
      assert(
        typeof publicUrl === 'string' && publicUrl.includes('/public/'),
        `missing public url header: ${publicUrl}`,
      )
      const publicPath = new URL(String(publicUrl)).pathname
      const publicGetRes = await fastify.inject({
        method: 'GET',
        url: publicPath,
      })
      assert(publicGetRes.statusCode === 200, `public link GET status=${publicGetRes.statusCode}`)
      assert(publicGetRes.payload === 'image-bytes', `public link payload=${publicGetRes.payload}`)
      ok('PUT vao public bucket -> tra ve public URL va GET duoc khong can x-api-key')
    } catch (err) {
      fail('PUT public bucket direct url header', err)
    }

    try {
      const getRes = await fastify.inject({
        method: 'GET',
        url: '/mybucket/path/to/file.txt',
        headers: { 'x-api-key': 'test' },
      })
      assert(getRes.statusCode === 200, `GET status=${getRes.statusCode}`)
      assert(getRes.payload === 'hello world', `GET payload=${getRes.payload}`)
      ok('GET /mybucket/path/to/file.txt -> stream body tu upstream mock')
    } catch (err) {
      fail('GET /mybucket/path/to/file.txt', err)
    }

    try {
      const headRes = await fastify.inject({
        method: 'HEAD',
        url: '/mybucket/path/to/file.txt',
        headers: { 'x-api-key': 'test' },
      })
      assert(headRes.statusCode === 200, `HEAD status=${headRes.statusCode}`)
      assert(headRes.payload === '', `HEAD payload length=${headRes.payload.length}`)
      ok('HEAD /mybucket/path/to/file.txt -> headers only, no body')
    } catch (err) {
      fail('HEAD /mybucket/path/to/file.txt', err)
    }

    try {
      const specialPut = await fastify.inject({
        method: 'PUT',
        url: '/mybucket/path/a&b.txt',
        headers: authHeaders,
        payload: 'special',
      })
      assert(specialPut.statusCode === 200, `PUT special key status=${specialPut.statusCode}`)

      for (const [url, payload] of [
        ['/mybucket/photos/a.txt', 'A'],
        ['/mybucket/photos/2026/b.txt', 'B'],
      ]) {
        const res = await fastify.inject({
          method: 'PUT',
          url,
          headers: authHeaders,
          payload,
        })
        assert(res.statusCode === 200, `seed PUT ${url} status=${res.statusCode}`)
      }

      const listRes = await fastify.inject({
        method: 'GET',
        url: '/mybucket?list-type=2',
        headers: { 'x-api-key': 'test' },
      })
      assert(listRes.statusCode === 200, `LIST status=${listRes.statusCode}`)
      assert(listRes.payload.includes('<ListBucketResult'), 'list xml missing root')
      assert(listRes.payload.includes('<Key>path/to/file.txt</Key>'), 'list missing object key')
      ok('GET /mybucket -> XML ListBucketResult tu route table')

      const encodedListRes = await fastify.inject({
        method: 'GET',
        url: '/mybucket?list-type=2&prefix=path/&encoding-type=url',
        headers: { 'x-api-key': 'test' },
      })
      assert(encodedListRes.statusCode === 200, `LIST encoding=url status=${encodedListRes.statusCode}`)
      assert(encodedListRes.payload.includes('<EncodingType>url</EncodingType>'), 'list missing EncodingType=url')
      assert(encodedListRes.payload.includes('<Key>path%2Fa%26b.txt</Key>'), 'encoded list missing URL-encoded key')
      ok('GET /mybucket?encoding-type=url -> key duoc URL-encode')
    } catch (err) {
      fail('GET /mybucket', err)
    }

    try {
      const prefixRes = await fastify.inject({
        method: 'GET',
        url: '/mybucket?list-type=2&prefix=photos/&delimiter=/',
        headers: { 'x-api-key': 'test' },
      })
      assert(prefixRes.statusCode === 200, `prefix LIST status=${prefixRes.statusCode}`)
      assert(prefixRes.payload.includes('<Key>photos/a.txt</Key>'), 'prefix list missing file')
      assert(prefixRes.payload.includes('<Prefix>photos/2026/</Prefix>'), 'prefix list missing CommonPrefixes')
      ok('GET /mybucket?prefix=photos/&delimiter=/ -> metadata CommonPrefixes + objects')
    } catch (err) {
      fail('GET /mybucket?prefix=photos/&delimiter=/', err)
    }

    try {
      const pagedRes = await fastify.inject({
        method: 'GET',
        url: '/mybucket?list-type=2&max-keys=1',
        headers: { 'x-api-key': 'test' },
      })
      assert(pagedRes.statusCode === 200, `paged LIST status=${pagedRes.statusCode}`)
      assert(/<NextContinuationToken>[^<]+<\/NextContinuationToken>/.test(pagedRes.payload), 'missing next continuation token')
      ok('GET /mybucket?max-keys=1 -> opaque continuation token duoc tra ve')
    } catch (err) {
      fail('GET /mybucket?max-keys=1', err)
    }

    try {
      const deniedRes = await fastify.inject({
        method: 'GET',
        url: '/mybucket/path/to/file.txt',
        headers: { 'x-api-key': 'wrong' },
      })
      assert(deniedRes.statusCode === 403, `403 status=${deniedRes.statusCode}`)
      assert(deniedRes.payload.includes('<Code>AccessDenied</Code>'), 'missing AccessDenied xml')
      ok('x-api-key sai -> 403 XML AccessDenied')
    } catch (err) {
      fail('x-api-key sai', err)
    }

    try {
      const presignedRes = await fastify.inject({
        method: 'GET',
        url: '/mybucket/path/to/file.txt?X-Amz-Credential=test%2F20260414%2Fap-southeast-1%2Fs3%2Faws4_request&X-Amz-Algorithm=AWS4-HMAC-SHA256',
      })
      assert(presignedRes.statusCode === 403, `presigned status=${presignedRes.statusCode}`)
      assert(presignedRes.payload.includes('<Code>AccessDenied</Code>'), 'presigned query should be rejected by default')
      ok('Pre-signed query X-Amz-Credential -> 403 khi che do insecure extract tat')
    } catch (err) {
      fail('Pre-signed query X-Amz-Credential', err)
    }

    try {
      const presignedLowercaseRes = await fastify.inject({
        method: 'GET',
        url: '/mybucket/path/to/file.txt?x-amz-credential=test%2F20260414%2Fap-southeast-1%2Fs3%2Faws4_request&x-amz-algorithm=AWS4-HMAC-SHA256',
      })
      assert(presignedLowercaseRes.statusCode === 403, `presigned lowercase status=${presignedLowercaseRes.statusCode}`)
      assert(presignedLowercaseRes.payload.includes('<Code>AccessDenied</Code>'), 'presigned lowercase query should be rejected by default')
      ok('Pre-signed query x-amz-credential (lowercase) -> 403 khi che do insecure extract tat')
    } catch (err) {
      fail('Pre-signed query x-amz-credential lowercase', err)
    }

    try {
      const healthRes = await fastify.inject({ method: 'GET', url: '/health' })
      const health = healthRes.json()
      assert(healthRes.statusCode === 200, `health status=${healthRes.statusCode}`)
      for (const key of ['status', 'accounts', 'routes', 'rtdb', 'quota']) {
        assert(Object.prototype.hasOwnProperty.call(health, key), `health missing ${key}`)
      }
      ok('GET /health -> 200 JSON co cac key chinh')
    } catch (err) {
      fail('GET /health', err)
    }

    try {
      const metricsRes = await fastify.inject({ method: 'GET', url: '/metrics' })
      assert(metricsRes.statusCode === 200, `metrics status=${metricsRes.statusCode}`)
      assert(metricsRes.payload.includes('s3proxy_requests_total'), 'metrics missing request counter')
      assert(metricsRes.payload.includes('s3proxy_metadata_list_requests_total'), 'metrics missing metadata list counter')
      ok('GET /metrics -> text co metrics moi cho metadata-backed list')
    } catch (err) {
      fail('GET /metrics', err)
    }

    try {
      const optionsRes = await fastify.inject({ method: 'OPTIONS', url: '/mybucket/path/to/file.txt' })
      assert(optionsRes.statusCode === 200, `OPTIONS status=${optionsRes.statusCode}`)
      assert(optionsRes.headers['access-control-allow-origin'] === '*', 'missing CORS header')
      ok('OPTIONS preflight -> 200 voi CORS headers')
    } catch (err) {
      fail('OPTIONS preflight', err)
    }

    try {
      const initRes = await fastify.inject({
        method: 'POST',
        url: '/mybucket/multi.bin?uploads',
        headers: { 'x-api-key': 'test' },
      })
      const uploadId = (initRes.payload.match(/<UploadId>([^<]+)<\/UploadId>/) || [])[1]
      assert(initRes.statusCode === 200, `init status=${initRes.statusCode}`)
      assert(uploadId, 'missing uploadId')

      const partRes = await fastify.inject({
        method: 'PUT',
        url: `/mybucket/multi.bin?uploadId=${uploadId}&partNumber=1`,
        headers: {
          'x-api-key': 'test',
          'content-type': 'application/octet-stream',
        },
        payload: 'abc',
      })
      assert(partRes.statusCode === 200, `part status=${partRes.statusCode}`)

      const completeRes = await fastify.inject({
        method: 'POST',
        url: `/mybucket/multi.bin?uploadId=${uploadId}`,
        headers: {
          'x-api-key': 'test',
          'content-type': 'application/xml',
        },
        payload: '<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>part-1</ETag></Part></CompleteMultipartUpload>',
      })
      assert(completeRes.statusCode === 200, `complete status=${completeRes.statusCode}`)

      const multipartGet = await fastify.inject({
        method: 'GET',
        url: '/mybucket/multi.bin',
        headers: { 'x-api-key': 'test' },
      })
      assert(multipartGet.statusCode === 200, `multipart GET status=${multipartGet.statusCode}`)
      assert(multipartGet.payload === 'abc', `multipart payload=${multipartGet.payload}`)
      ok('Multipart: initiate, upload part, complete -> object doc duoc')
    } catch (err) {
      fail('Multipart flow', err)
    }

    try {
      const deleteRes = await fastify.inject({
        method: 'DELETE',
        url: '/mybucket/path/to/file.txt',
        headers: { 'x-api-key': 'test' },
      })
      const route = getRoute(Buffer.from('mybucket/path/to/file.txt').toString('base64url'))
      const afterDeleteGet = await fastify.inject({
        method: 'GET',
        url: '/mybucket/path/to/file.txt',
        headers: { 'x-api-key': 'test' },
      })
      const listAfterDelete = await fastify.inject({
        method: 'GET',
        url: '/mybucket?list-type=2',
        headers: { 'x-api-key': 'test' },
      })

      assert(deleteRes.statusCode === 204, `DELETE status=${deleteRes.statusCode}`)
      assert(route && route.state === ROUTE_STATE.DELETED, `route=${JSON.stringify(route)}`)
      assert(afterDeleteGet.statusCode === 404, `GET after delete status=${afterDeleteGet.statusCode}`)
      assert(!listAfterDelete.payload.includes('<Key>path/to/file.txt</Key>'), 'deleted object still listed')
      ok('DELETE /mybucket/path/to/file.txt -> tombstone duoc luu, GET 404 va LIST an object')
    } catch (err) {
      fail('DELETE /mybucket/path/to/file.txt', err)
    }
  } finally {
    await fastify.close().catch(() => {})
    await upstream.close().catch(() => {})
    db.close()
    for (const file of [TEST_DB, `${TEST_DB}-shm`, `${TEST_DB}-wal`]) {
      if (existsSync(file)) unlinkSync(file)
    }
  }

  console.log('─'.repeat(60))
  console.log(`Results: ${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
