import { createReadStream, existsSync } from 'fs'
import { pipeline } from 'stream/promises'
import {
  cancelBackupJob,
  getJobLiveStatus,
  listBackupJobLedger,
  listBackupJobs,
  pauseBackupJob,
  removeBackupJob,
  resumeBackupJob,
  startBackupJob,
} from '../backup/backupManager.js'
import config from '../config.js'
import {
  checkBackendHealth,
  diagnoseBackend,
  listMigrationsFromDb,
  migrateBackendObjects,
  replaceBackendConfig,
  rollbackMigration,
} from '../backup/backendReplacer.js'
import { startRestoreJob, verifyRestoreIntegrity } from '../backup/restoreManager.js'
import { getAccountById } from '../db.js'

function sanitizeSecrets(value) {
  if (Array.isArray(value)) return value.map(sanitizeSecrets)
  if (!value || typeof value !== 'object') return value
  const masked = {}
  for (const [key, entry] of Object.entries(value)) {
    if (/(secret|token|password|key)/i.test(key)) {
      masked[key] = typeof entry === 'string' && entry.length > 4
        ? `${entry.slice(0, 2)}***${entry.slice(-2)}`
        : '***'
    } else {
      masked[key] = sanitizeSecrets(entry)
    }
  }
  return masked
}

function sanitizeJob(job) {
  if (!job) return job
  return {
    ...job,
    destination_config: sanitizeSecrets(job.destination_config || {}),
  }
}

export default async function backupRoutes(fastify) {
  fastify.addHook('preHandler', fastify.authenticate)
  fastify.addHook('preHandler', async (request, reply) => {
    if (config.BACKUP_ENABLED) return
    const routePath = request.routerPath || request.routeOptions?.url || ''
    const urlPath = String(request.url || '').split('?')[0]
    const allowedWhenDisabled = ['/admin/backup/config']
    if (allowedWhenDisabled.includes(routePath) || allowedWhenDisabled.includes(urlPath)) return

    return reply.code(503).send({
      ok: false,
      error: 'BACKUP_DISABLED',
      message: 'Backup system is disabled. Set BACKUP_ENABLED=true to enable.',
      configEndpoint: '/admin/backup/config',
    })
  })

  fastify.get('/admin/backup/jobs', async (request, reply) => {
    const limit = Number(request.query.limit || 20)
    const offset = Number(request.query.offset || 0)
    const status = request.query.status ? String(request.query.status) : undefined
    return { ok: true, jobs: listBackupJobs({ limit, offset, status }).map(sanitizeJob) }
  })

  fastify.get('/admin/backup/jobs/:jobId', async (request, reply) => {
    const row = getJobLiveStatus(request.params.jobId)
    if (!row) {
      reply.code(404)
      return { ok: false, error: 'JOB_NOT_FOUND' }
    }
    return { ok: true, job: sanitizeJob(row) }
  })

  fastify.post('/admin/backup/jobs', async (request, reply) => {
    const body = request.body || {}
    const destinationType = String(body.destinationType || '').trim()
    if (!destinationType) {
      reply.code(400)
      return { ok: false, error: 'MISSING_DESTINATION_TYPE' }
    }

    try {
      const job = await startBackupJob({
        type: body.type || 'full',
        destinationType,
        destinationConfig: body.destinationConfig || {},
        accountFilter: Array.isArray(body.accountFilter) ? body.accountFilter : [],
        options: body.options || {},
      })

      reply.code(202)
      return { ok: true, job: sanitizeJob(job) }
    } catch (err) {
      reply.code(400)
      return { ok: false, error: err.message }
    }
  })

  fastify.post('/admin/backup/jobs/:jobId/cancel', async (request) => {
    await cancelBackupJob(request.params.jobId)
    return { ok: true }
  })

  fastify.post('/admin/backup/jobs/:jobId/stop', async (request) => {
    await cancelBackupJob(request.params.jobId)
    return { ok: true, action: 'stop' }
  })

  fastify.post('/admin/backup/jobs/:jobId/pause', async (request) => {
    await pauseBackupJob(request.params.jobId)
    return { ok: true, action: 'pause' }
  })

  fastify.post('/admin/backup/jobs/:jobId/resume', async (request) => {
    const job = await resumeBackupJob(request.params.jobId)
    return { ok: true, action: 'resume', job: sanitizeJob(job) }
  })

  fastify.delete('/admin/backup/jobs/:jobId', async (request, reply) => {
    try {
      removeBackupJob(request.params.jobId)
      return { ok: true, action: 'delete' }
    } catch (err) {
      reply.code(409)
      return { ok: false, error: err.message }
    }
  })

  fastify.get('/admin/backup/jobs/:jobId/ledger', async (request) => {
    const limit = Number(request.query.limit || 200)
    const offset = Number(request.query.offset || 0)
    return { ok: true, entries: listBackupJobLedger(request.params.jobId, { limit, offset }) }
  })

  fastify.get('/admin/backup/config', async () => ({
    ok: true,
    config: {
      backupEnabled: config.BACKUP_ENABLED,
      backupRtdbConfigured: Boolean(config.BACKUP_RTDB_URL),
      backupConcurrency: config.BACKUP_CONCURRENCY,
      backupChunkStreamMs: config.BACKUP_CHUNK_STREAM_MS,
      backupMaxObjectSizeMb: config.BACKUP_MAX_OBJECT_SIZE_MB,
      destinationTypes: ['local', 'mock', 's3', 'zip', 'gdrive', 'onedrive'],
    },
  }))

  fastify.post('/admin/backup/restore', async (request, reply) => {
    const payload = request.body || {}
    const result = await startRestoreJob({
      sourceJobId: payload.sourceJobId,
      sourceDestinationType: payload.sourceDestinationType || payload.sourceDestination?.type,
      sourceDestinationConfig: payload.sourceDestinationConfig || payload.sourceDestination?.config || {},
      targetAccountMapping: payload.targetAccountMapping || {},
      options: payload.options || {},
      logger: fastify.log,
    })
    if (result?.status === 'not_implemented') {
      return reply.code(501).send({ ok: false, error: 'NOT_IMPLEMENTED', result })
    }
    return { ok: true, result }
  })

  fastify.get('/admin/backup/restore/:jobId/verify', async (request, reply) => {
    const result = await verifyRestoreIntegrity(request.params.jobId, null)
    if (result?.status === 'not_implemented') {
      return reply.code(501).send({ ok: false, error: 'NOT_IMPLEMENTED', result })
    }
    return { ok: true, result }
  })

  fastify.get('/admin/backup/backends/:accountId/health', async (request, reply) => {
    const account = getAccountById(request.params.accountId)
    if (!account) {
      reply.code(404)
      return { ok: false, error: 'ACCOUNT_NOT_FOUND' }
    }
    const result = await checkBackendHealth(account)
    if (result?.status === 'not_implemented') {
      return reply.code(501).send({ ok: false, error: 'NOT_IMPLEMENTED', result })
    }
    return { ok: true, result }
  })

  fastify.post('/admin/backup/backends/replace-config', async (request, reply) => {
    const body = request.body || {}
    const result = await replaceBackendConfig(body.sourceAccountId, body.newAccountConfig || {}, { dryRun: Boolean(body.dryRun) })
    if (result?.status === 'not_implemented') {
      return reply.code(501).send({ ok: false, error: 'NOT_IMPLEMENTED', result })
    }
    return { ok: true, result }
  })

  fastify.post('/admin/backup/backends/migrate', async (request, reply) => {
    const body = request.body || {}
    const result = await migrateBackendObjects(body.sourceAccountId, body.targetAccountId, body.options || {}, fastify.log)
    if (result?.status === 'not_implemented') {
      return reply.code(501).send({ ok: false, error: 'NOT_IMPLEMENTED', result })
    }
    return { ok: true, result }
  })

  fastify.get('/admin/backup/backends/:accountId/diagnose', async (request, reply) => {
    const result = await diagnoseBackend(request.params.accountId)
    if (result?.error === 'not_implemented') {
      return reply.code(501).send({ ok: false, error: 'NOT_IMPLEMENTED', result })
    }
    return { ok: true, result }
  })

  fastify.get('/admin/backup/jobs/:jobId/download', async (request, reply) => {
    const job = getJobLiveStatus(request.params.jobId)
    if (!job) return reply.code(404).send({ ok: false, error: 'JOB_NOT_FOUND' })
    if (job.destination_type !== 'zip') {
      return reply.code(400).send({ ok: false, error: 'JOB_NOT_ZIP_TYPE' })
    }
    if (job.status !== 'completed') {
      return reply.code(409).send({ ok: false, error: 'JOB_NOT_COMPLETED', status: job.status })
    }
    const outputPath = job.options?.outputPath
    if (!outputPath) {
      return reply.code(404).send({ ok: false, error: 'ZIP_OUTPUT_PATH_NOT_SET' })
    }
    if (!existsSync(outputPath)) {
      return reply.code(404).send({ ok: false, error: 'ZIP_FILE_NOT_FOUND', path: outputPath })
    }
    reply.raw.setHeader('Content-Type', 'application/zip')
    reply.raw.setHeader('Content-Disposition', `attachment; filename="backup-${request.params.jobId}.zip"`)
    reply.raw.setHeader('Cache-Control', 'no-store')
    const fileStream = createReadStream(outputPath)
    await pipeline(fileStream, reply.raw)
    return reply
  })

  fastify.get('/admin/backup/jobs/:jobId/events', async (request, reply) => {
    const { jobId } = request.params
    reply.raw.setHeader('Content-Type', 'text/event-stream')
    reply.raw.setHeader('Cache-Control', 'no-cache')
    reply.raw.setHeader('Connection', 'keep-alive')
    reply.raw.flushHeaders?.()

    const send = (data) => {
      if (!reply.raw.writableEnded) {
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`)
      }
    }

    const interval = setInterval(() => {
      const status = getJobLiveStatus(jobId)
      if (!status) {
        clearInterval(interval)
        reply.raw.end()
        return
      }
      send(sanitizeJob(status))
      if (['completed', 'failed', 'cancelled'].includes(status.status)) {
        clearInterval(interval)
        reply.raw.end()
      }
    }, 1000)

    request.raw.on('close', () => clearInterval(interval))
    return reply
  })

  fastify.post('/admin/backup/config/test', async (request, reply) => {
    const { rtdbUrl } = request.body || {}
    const url = rtdbUrl || config.BACKUP_RTDB_URL
    if (!url) return reply.code(400).send({ ok: false, error: 'NO_RTDB_URL' })
    try {
      const testUrl = url.endsWith('.json') ? url : `${url}.json`
      const res = await fetch(testUrl, { method: 'GET', signal: AbortSignal.timeout(5000) })
      return { ok: res.ok, status: res.status }
    } catch (err) {
      return reply.code(502).send({ ok: false, error: err.message })
    }
  })

  fastify.get('/admin/backup/backends/migrations', async (request) => {
    const limit = Number(request.query.limit || 20)
    const offset = Number(request.query.offset || 0)
    const migrations = listMigrationsFromDb({ limit, offset })
    return { ok: true, migrations }
  })

  fastify.post('/admin/backup/backends/migrations/:migrationId/rollback', async (request) => {
    const result = await rollbackMigration(request.params.migrationId)
    return { ok: true, result }
  })
}
