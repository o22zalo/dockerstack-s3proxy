import {
  cancelBackupJob,
  getJobLiveStatus,
  getBackupJob,
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

export default async function backupRoutes(fastify) {
  fastify.addHook('preHandler', fastify.authenticate)

  fastify.get('/admin/backup/jobs', async (request, reply) => {
    const limit = Number(request.query.limit || 20)
    const offset = Number(request.query.offset || 0)
    const status = request.query.status ? String(request.query.status) : undefined
    return { ok: true, jobs: listBackupJobs({ limit, offset, status }) }
  })

  fastify.get('/admin/backup/jobs/:jobId', async (request, reply) => {
    const row = getJobLiveStatus(request.params.jobId)
    if (!row) {
      reply.code(404)
      return { ok: false, error: 'JOB_NOT_FOUND' }
    }
    return { ok: true, job: row }
  })

  fastify.post('/admin/backup/jobs', async (request, reply) => {
    const body = request.body || {}
    const destinationType = String(body.destinationType || '').trim()
    if (!destinationType) {
      reply.code(400)
      return { ok: false, error: 'MISSING_DESTINATION_TYPE' }
    }

    const job = await startBackupJob({
      type: body.type || 'full',
      destinationType,
      destinationConfig: body.destinationConfig || {},
      accountFilter: Array.isArray(body.accountFilter) ? body.accountFilter : [],
      options: body.options || {},
    })

    reply.code(202)
    return { ok: true, job }
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
    return { ok: true, action: 'resume', job }
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

  fastify.post('/admin/backup/restore', async (request) => {
    const payload = request.body || {}
    const result = await startRestoreJob({
      sourceJobId: payload.sourceJobId,
      sourceDestination: payload.sourceDestination,
      targetAccountMapping: payload.targetAccountMapping || {},
      options: payload.options || {},
      logger: fastify.log,
    })
    return { ok: true, result }
  })

  fastify.get('/admin/backup/restore/:jobId/verify', async (request) => {
    const result = await verifyRestoreIntegrity(request.params.jobId, null)
    return { ok: true, result }
  })

  fastify.get('/admin/backup/backends/:accountId/health', async (request, reply) => {
    const account = getAccountById(request.params.accountId)
    if (!account) {
      reply.code(404)
      return { ok: false, error: 'ACCOUNT_NOT_FOUND' }
    }
    const result = await checkBackendHealth(account)
    return { ok: true, result }
  })

  fastify.post('/admin/backup/backends/replace-config', async (request) => {
    const body = request.body || {}
    const result = await replaceBackendConfig(body.sourceAccountId, body.newAccountConfig || {}, { dryRun: Boolean(body.dryRun) })
    return { ok: true, result }
  })

  fastify.post('/admin/backup/backends/migrate', async (request) => {
    const body = request.body || {}
    const result = await migrateBackendObjects(body.sourceAccountId, body.targetAccountId, body.options || {}, fastify.log)
    return { ok: true, result }
  })

  fastify.get('/admin/backup/backends/:accountId/diagnose', async (request) => {
    const result = await diagnoseBackend(request.params.accountId)
    return { ok: true, result }
  })
}
