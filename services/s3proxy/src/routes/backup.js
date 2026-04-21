import {
  cancelBackupJob,
  getBackupJob,
  listBackupJobs,
  startBackupJob,
} from '../backup/backupManager.js'

export default async function backupRoutes(fastify) {
  fastify.get('/admin/backup/jobs', async (request, reply) => {
    const limit = Number(request.query.limit || 20)
    const offset = Number(request.query.offset || 0)
    const status = request.query.status ? String(request.query.status) : undefined
    return { ok: true, jobs: listBackupJobs({ limit, offset, status }) }
  })

  fastify.get('/admin/backup/jobs/:jobId', async (request, reply) => {
    const row = getBackupJob(request.params.jobId)
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
}
