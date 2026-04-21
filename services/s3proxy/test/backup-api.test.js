import { mkdirSync, existsSync, unlinkSync } from 'fs'

process.env.PROXY_API_KEY = process.env.PROXY_API_KEY || 'test'
process.env.FIREBASE_RTDB_URL = process.env.FIREBASE_RTDB_URL || 'https://dummy.firebaseio.com'
process.env.FIREBASE_DB_SECRET = process.env.FIREBASE_DB_SECRET || 'dummy'
process.env.BACKUP_RTDB_URL = ''
const TEST_DB_DIR = '../../.docker-volumes/s3proxy-data'
process.env.SQLITE_PATH = `${TEST_DB_DIR}/test-backup-api.db`
process.env.LOG_LEVEL = 'fatal'

const TEST_DB = process.env.SQLITE_PATH
mkdirSync(TEST_DB_DIR, { recursive: true })
for (const file of [TEST_DB, `${TEST_DB}-shm`, `${TEST_DB}-wal`]) {
  if (existsSync(file)) unlinkSync(file)
}

const Fastify = (await import('fastify')).default
const authPlugin = (await import('../src/plugins/auth.js')).default
const errorHandler = (await import('../src/plugins/errorHandler.js')).default
const backupRoutes = (await import('../src/routes/backup.js')).default
const { db } = await import('../src/db.js')

let passed = 0
let failed = 0

function ok(label) { console.log(`✅ ${label}`); passed += 1 }
function fail(label, err) { console.error(`❌ ${label}`); console.error(`   ${err?.message || err}`); failed += 1 }
function assert(condition, message) { if (!condition) throw new Error(message) }

async function main() {
  const fastify = Fastify({ logger: false })
  await fastify.register(authPlugin)
  await fastify.register(errorHandler)
  await fastify.register(backupRoutes)

  try {
    const unauth = await fastify.inject({ method: 'GET', url: '/admin/backup/jobs' })
    assert(unauth.statusCode === 403, `unauth expected 403 got ${unauth.statusCode}`)
    ok('backup routes require auth')

    const create = await fastify.inject({
      method: 'POST',
      url: '/admin/backup/jobs',
      headers: { 'x-api-key': 'test', 'content-type': 'application/json' },
      payload: {
        type: 'full',
        destinationType: 'local',
        destinationConfig: { rootDir: '/backup-data' },
      },
    })
    assert(create.statusCode === 202, `create expected 202 got ${create.statusCode}`)
    const created = create.json()
    assert(created?.job?.job_id, 'missing job id')
    ok('create backup job works with auth')

    const pause = await fastify.inject({ method: 'POST', url: `/admin/backup/jobs/${created.job.job_id}/pause`, headers: { 'x-api-key': 'test' } })
    assert(pause.statusCode === 200, `pause expected 200 got ${pause.statusCode}`)
    ok('pause endpoint works')

    const resume = await fastify.inject({ method: 'POST', url: `/admin/backup/jobs/${created.job.job_id}/resume`, headers: { 'x-api-key': 'test' } })
    assert(resume.statusCode === 200, `resume expected 200 got ${resume.statusCode}`)
    ok('resume endpoint works')

    const cfg = await fastify.inject({ method: 'GET', url: '/admin/backup/config', headers: { 'x-api-key': 'test' } })
    assert(cfg.statusCode === 200, `config expected 200 got ${cfg.statusCode}`)
    assert(cfg.json()?.config?.destinationTypes?.includes('s3'), 'expected destination type s3')
    ok('config endpoint exposes supported destinations')
  } catch (err) {
    fail('backup api', err)
  } finally {
    await fastify.close()
    try { db.close() } catch {}
  }

  console.log('─'.repeat(60))
  console.log(`Result: ${passed} passed | ${failed} failed`)
  console.log('─'.repeat(60))
  if (failed > 0) process.exit(1)
}

main()
