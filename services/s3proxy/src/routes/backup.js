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
import { checkBackendHealth, diagnoseBackend, migrateBackendObjects, replaceBackendConfig } from '../backup/backendReplacer.js'
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
      destinationTypes: ['local', 'mock', 's3'],
    },
  }))

  fastify.post('/admin/backup/restore', async (request, reply) => {
    const payload = request.body || {}
    const result = await startRestoreJob({
      sourceJobId: payload.sourceJobId,
      sourceDestination: payload.sourceDestination,
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
}
