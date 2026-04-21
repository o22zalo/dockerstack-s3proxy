import { createServer } from 'http'
import { mkdirSync, existsSync, unlinkSync } from 'fs'

process.env.PROXY_API_KEY = process.env.PROXY_API_KEY || 'test'
process.env.FIREBASE_RTDB_URL = process.env.FIREBASE_RTDB_URL || 'http://127.0.0.1:9'
process.env.FIREBASE_DB_SECRET = process.env.FIREBASE_DB_SECRET || 'dummy'
process.env.BACKUP_RTDB_URL = ''
const TEST_DB_DIR = '../../.docker-volumes/s3proxy-data'
process.env.SQLITE_PATH = `${TEST_DB_DIR}/test-backup-system.db`
process.env.LOG_LEVEL = 'fatal'

const TEST_DB = process.env.SQLITE_PATH
mkdirSync(TEST_DB_DIR, { recursive: true })
for (const file of [TEST_DB, `${TEST_DB}-shm`, `${TEST_DB}-wal`]) {
  if (existsSync(file)) unlinkSync(file)
}

let passed = 0
let failed = 0

function ok(label) { console.log(`✅ ${label}`); passed += 1 }
function fail(label, err) { console.error(`❌ ${label}`); console.error(`   ${err?.message || err}`); failed += 1 }
function assert(condition, message) { if (!condition) throw new Error(message) }

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}

async function startFakeS3() {
  const objectMap = new Map([['bucket-a/path/file.txt', Buffer.from('hello backup')]])
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const parts = url.pathname.split('/').filter(Boolean)
    const key = `${parts[0]}/${parts.slice(1).join('/')}`

    if (req.method === 'HEAD') {
      if (!objectMap.has(key)) { res.statusCode = 404; res.end(''); return }
      const body = objectMap.get(key)
      res.statusCode = 200
      res.setHeader('ETag', '"etag-1"')
      res.setHeader('Content-Length', body.length)
      res.setHeader('Content-Type', 'text/plain')
      res.end('')
      return
    }

    if (req.method === 'GET') {
      if (url.searchParams.get('list-type') === '2') {
        const bucket = parts[0]
        const keys = [...objectMap.keys()]
          .filter((value) => value.startsWith(`${bucket}/`))
          .map((value) => value.slice(bucket.length + 1))
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/xml')
        res.end([
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<ListBucketResult>',
          ...keys.map((entry) => `<Contents><Key>${entry}</Key><Size>${objectMap.get(`${bucket}/${entry}`).length}</Size><ETag>"etag-1"</ETag></Contents>`),
          '</ListBucketResult>',
        ].join(''))
        return
      }
      if (!objectMap.has(key)) { res.statusCode = 404; res.end('missing'); return }
      const body = objectMap.get(key)
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/plain')
      res.end(body)
      return
    }

    const body = await readBody(req)
    objectMap.set(key, body)
    res.statusCode = 200
    res.end('ok')
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  }
}

async function startMockBackupReceiver() {
  const received = []
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (req.method === 'PUT' && url.pathname.startsWith('/upload/')) {
      const key = decodeURIComponent(url.pathname.replace('/upload/', ''))
      const body = await readBody(req)
      received.push({ key, body: body.toString('utf8') })
      res.statusCode = 200
      res.setHeader('x-mock-location', `mock://storage/${key}`)
      res.end('ok')
      return
    }

    res.statusCode = 404
    res.end('missing')
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    received,
    close: () => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  }
}

const { upsertAccount, commitUploadedObjectMetadata, db } = await import('../src/db.js')
const { startBackupJob, runPendingBackupJobs, getBackupJob } = await import('../src/backup/backupManager.js')

async function main() {
  const fakeS3 = await startFakeS3()
  const receiver = await startMockBackupReceiver()

  try {
    upsertAccount({
      account_id: 'acc-backup',
      access_key_id: 'key',
      secret_key: 'secret',
      endpoint: fakeS3.endpoint,
      region: 'us-east-1',
      bucket: 'bucket-a',
      active: 1,
      used_bytes: 0,
      quota_bytes: 1000000,
      added_at: Date.now(),
    })

    commitUploadedObjectMetadata({
      encoded_key: 'enc-file',
      account_id: 'acc-backup',
      bucket: 'bucket-a',
      object_key: 'path/file.txt',
      backend_key: 'path/file.txt',
      size_bytes: 12,
      etag: 'etag-1',
      content_type: 'text/plain',
    })

    await startBackupJob({
      type: 'full',
      destinationType: 'mock',
      destinationConfig: { endpoint: receiver.endpoint },
      accountFilter: ['acc-backup'],
      options: { skipExistingByEtag: false },
    })
    ok('create backup job pending')

    const processed = await runPendingBackupJobs(console)
    assert(processed?.status === 'completed', `job status expected completed, got ${processed?.status}`)
    ok('run pending backup job completed')

    assert(receiver.received.length === 1, `expected 1 uploaded object, got ${receiver.received.length}`)
    assert(receiver.received[0].body === 'hello backup', 'uploaded payload mismatch')
    ok('mock destination received object stream')

    const jobs = getBackupJob(processed.job_id)
    assert(jobs?.progress?.doneObjects === 1, 'doneObjects should be 1')
    ok('job progress persisted to sqlite')
  } catch (err) {
    fail('backup system e2e', err)
  } finally {
    await fakeS3.close()
    await receiver.close()
    try { db.close() } catch {}
  }

  console.log('─'.repeat(60))
  console.log(`Result: ${passed} passed | ${failed} failed`)
  console.log('─'.repeat(60))
  if (failed > 0) process.exit(1)
}

main()
