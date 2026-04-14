/**
 * src/routes/admin.js
 * Admin UI + APIs for runtime status, cron management and S3 tests.
 */

import { randomBytes } from 'crypto'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3'

import config from '../config.js'
import { getAllAccounts } from '../db.js'
import { getAccountsStats } from '../accountPool.js'
import { getRtdbState } from './health.js'
import {
  getCronJobKinds,
  listCronJobs,
  removeCronJob,
  runCronJobNow,
  saveCronJob,
} from '../cronScheduler.js'
import { createS3Client } from '../inventoryScanner.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const adminHtml = readFileSync(join(__dirname, '..', 'admin-ui.html'), 'utf-8')

function formatPercent(used, quota) {
  if (!quota) return 0
  return Number(((used / quota) * 100).toFixed(2))
}

function toPublicAccount(row) {
  return {
    accountId: row.account_id,
    endpoint: row.endpoint,
    region: row.region,
    bucket: row.bucket,
    active: row.active === 1 || row.active === true,
    usedBytes: row.used_bytes ?? 0,
    quotaBytes: row.quota_bytes ?? 0,
    usedPercent: formatPercent(row.used_bytes ?? 0, row.quota_bytes ?? 0),
    addedAt: row.added_at ?? null,
  }
}

function pocketbaseCompatibility() {
  return {
    supported: {
      putObject: true,
      getObject: true,
      deleteObject: true,
      headObject: true,
      multipartUpload: true,
      listBucket: true,
      presignedStyleAuth: true,
    },
    caveats: [
      'Nên chạy PocketBase với S3 path-style endpoint trỏ thẳng vào s3proxy.',
      'Admin endpoint /admin hiện skip x-api-key, cần đặt sau Caddy Basic Auth.',
      'Một số API S3 nâng cao (ACL/policy/lifecycle...) chưa implement đầy đủ.',
    ],
  }
}

function readStreamBodyToString(body) {
  if (!body) return Promise.resolve('')
  if (typeof body.transformToString === 'function') {
    return body.transformToString()
  }

  return new Promise((resolve, reject) => {
    const chunks = []
    body.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    body.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    body.on('error', reject)
  })
}

async function runS3Probe(account) {
  const client = createS3Client(account)
  const probeKey = `${config.ADMIN_TEST_PREFIX}/${account.account_id}-${Date.now()}-${randomBytes(3).toString('hex')}.txt`
  const payload = `s3proxy probe ${new Date().toISOString()}`

  const timings = {}
  const startedAt = Date.now()

  const t1 = Date.now()
  await client.send(new ListObjectsV2Command({ Bucket: account.bucket, MaxKeys: 3 }))
  timings.listMs = Date.now() - t1

  const t2 = Date.now()
  await client.send(new PutObjectCommand({
    Bucket: account.bucket,
    Key: probeKey,
    Body: payload,
    ContentType: 'text/plain; charset=utf-8',
  }))
  timings.putMs = Date.now() - t2

  const t3 = Date.now()
  const getResult = await client.send(new GetObjectCommand({ Bucket: account.bucket, Key: probeKey }))
  const fetchedPayload = await readStreamBodyToString(getResult.Body)
  timings.getMs = Date.now() - t3

  const t4 = Date.now()
  await client.send(new DeleteObjectCommand({ Bucket: account.bucket, Key: probeKey }))
  timings.deleteMs = Date.now() - t4

  return {
    accountId: account.account_id,
    bucket: account.bucket,
    probeKey,
    ok: fetchedPayload === payload,
    bytes: payload.length,
    durationMs: Date.now() - startedAt,
    timings,
  }
}

function parseBodyObject(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {}
  return body
}

export default async function adminRoutes(fastify, _opts) {
  fastify.get('/admin', {
    config: { skipAuth: true },
  }, async (_request, reply) => {
    reply.type('text/html; charset=utf-8').send(adminHtml)
  })

  fastify.get('/admin/api/overview', {
    config: { skipAuth: true },
  }, async (_request, reply) => {
    const stats = getAccountsStats()
    const accounts = getAllAccounts().map(toPublicAccount)
    const rtdb = getRtdbState()

    reply.send({
      status: rtdb.connected ? 'ok' : 'degraded',
      instanceId: config.INSTANCE_ID,
      deployVersion: config.DEPLOY_VERSION,
      stats,
      rtdb,
      jobs: listCronJobs(),
      cronKinds: getCronJobKinds(),
      accounts,
      compatibility: pocketbaseCompatibility(),
    })
  })

  fastify.post('/admin/api/cron-jobs', {
    config: { skipAuth: true },
  }, async (request, reply) => {
    try {
      const saved = saveCronJob(parseBodyObject(request.body))
      return reply.send({ ok: true, job: saved })
    } catch (err) {
      return reply.code(400).send({ ok: false, error: err?.message ?? String(err) })
    }
  })

  fastify.post('/admin/api/cron-jobs/:jobId/run', {
    config: { skipAuth: true },
  }, async (request, reply) => {
    try {
      const result = await runCronJobNow(request.params.jobId)
      return reply.send({ ok: true, jobId: result.job_id, lastRunStatus: result.lastRunStatus })
    } catch (err) {
      return reply.code(404).send({ ok: false, error: err?.message ?? String(err) })
    }
  })

  fastify.delete('/admin/api/cron-jobs/:jobId', {
    config: { skipAuth: true },
  }, async (request, reply) => {
    try {
      const removed = removeCronJob(request.params.jobId)
      if (!removed) {
        return reply.code(404).send({ ok: false, error: 'job not found' })
      }
      return reply.send({ ok: true })
    } catch (err) {
      return reply.code(400).send({ ok: false, error: err?.message ?? String(err) })
    }
  })

  fastify.post('/admin/api/test-s3', {
    config: { skipAuth: true },
  }, async (request, reply) => {
    const payload = parseBodyObject(request.body)
    const all = getAllAccounts().filter((item) => item.active === 1 || item.active === true)

    let targets = []
    if (payload.allActive === true) {
      targets = all
    } else if (payload.accountId) {
      targets = all.filter((item) => item.account_id === String(payload.accountId))
    }

    if (targets.length === 0) {
      return reply.code(400).send({ ok: false, error: 'account not found or inactive' })
    }

    const results = []
    for (const account of targets) {
      try {
        const result = await runS3Probe(account)
        results.push(result)
      } catch (err) {
        results.push({
          accountId: account.account_id,
          bucket: account.bucket,
          ok: false,
          error: err?.message ?? String(err),
        })
      }
    }

    return reply.send({
      ok: results.every((item) => item.ok),
      count: results.length,
      results,
    })
  })
}
