import config from '../config.js'
import { getAllAccounts, getAllRoutes } from '../db.js'
import {
  createBackupJob,
  getJobById,
  getPendingJob,
  listJobs,
  updateJobProgress,
  updateJobStatus,
  upsertLedgerEntry,
} from './backupJournal.js'
import { createDestination } from './destinations/index.js'
import { copyObjectToDestination } from './backupWorker.js'

const activeJobs = new Map()

function buildSemaphore(max) {
  let count = 0
  const queue = []
  return {
    async acquire() {
      if (count < max) {
        count += 1
        return
      }
      await new Promise((resolve) => queue.push(resolve))
      count += 1
    },
    release() {
      count = Math.max(0, count - 1)
      const next = queue.shift()
      if (next) next()
    },
  }
}

export async function startBackupJob(payload) {
  return createBackupJob(payload)
}

export function listBackupJobs(options = {}) {
  return listJobs(options)
}

export function getBackupJob(jobId) {
  return getJobById(jobId)
}

export async function cancelBackupJob(jobId) {
  const active = activeJobs.get(jobId)
  if (active) {
    active.abortController.abort('cancelled')
    activeJobs.delete(jobId)
  }
  await updateJobStatus(jobId, 'cancelled', { completedAt: Date.now(), lastError: 'cancelled_by_user' })
}

export async function processBackupJob(job, logger = console) {
  if (!job) return null

  const abortController = new AbortController()
  activeJobs.set(job.job_id, { abortController })
  await updateJobStatus(job.job_id, 'running', { startedAt: Date.now() })

  const accountFilter = new Set(job.account_filter || [])
  const accounts = getAllAccounts().filter((account) => account.active === 1)
  const targetAccounts = accountFilter.size > 0
    ? accounts.filter((account) => accountFilter.has(account.account_id))
    : accounts

  const routeRows = getAllRoutes().filter((route) => route.state === 'ACTIVE' && route.route_scope === 'main')
  const filteredRoutes = routeRows.filter((route) => targetAccounts.some((account) => account.account_id === route.account_id))

  const destinationConfig = job.destination_config || {}
  const destinationType = job.destination_type
  const destinations = Array.isArray(destinationConfig.destinations) && destinationConfig.destinations.length > 0
    ? destinationConfig.destinations.map((item) => createDestination(item.type || destinationType, item.config || {}))
    : [createDestination(destinationType, destinationConfig)]

  const progress = {
    totalObjects: filteredRoutes.length,
    doneObjects: 0,
    failedObjects: 0,
    totalBytes: filteredRoutes.reduce((sum, route) => sum + Number(route.size_bytes || 0), 0),
    doneBytes: 0,
    lastError: null,
  }
  await updateJobProgress(job.job_id, progress)

  const semaphore = buildSemaphore(Math.max(1, Number(config.BACKUP_CONCURRENCY || 3)))
  const tasks = []

  for (const route of filteredRoutes) {
    if (abortController.signal.aborted) break

    const account = targetAccounts.find((item) => item.account_id === route.account_id)
    if (!account) continue

    upsertLedgerEntry({
      job_id: job.job_id,
      account_id: account.account_id,
      backend_bucket: account.bucket,
      backend_key: route.backend_key,
      encoded_key: route.encoded_key,
      status: 'pending',
      src_etag: route.etag,
      src_size_bytes: route.size_bytes,
    })

    await semaphore.acquire()
    const task = (async () => {
      try {
        const results = await Promise.all(destinations.map((destination) => copyObjectToDestination({
          account,
          backendKey: route.backend_key,
          encodedKey: route.encoded_key,
          jobId: job.job_id,
          destination,
          options: job.options,
          signal: abortController.signal,
          logger,
        })))

        const failed = results.some((result) => result.status === 'failed')
        if (failed) {
          progress.failedObjects += 1
          progress.lastError = results.find((result) => result.error)?.error || 'unknown copy failure'
        } else {
          progress.doneObjects += 1
          progress.doneBytes += Number(route.size_bytes || 0)
        }
      } finally {
        semaphore.release()
      }
    })()

    tasks.push(task)
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(config.BACKUP_CHUNK_STREAM_MS || 50))))
  }

  await Promise.all(tasks)
  await updateJobProgress(job.job_id, progress)

  if (abortController.signal.aborted) {
    await updateJobStatus(job.job_id, 'cancelled', { completedAt: Date.now(), lastError: 'cancelled' })
  } else if (progress.failedObjects > 0) {
    await updateJobStatus(job.job_id, 'failed', { completedAt: Date.now(), lastError: progress.lastError || 'some objects failed' })
  } else {
    await updateJobStatus(job.job_id, 'completed', { completedAt: Date.now() })
  }

  activeJobs.delete(job.job_id)
  return getJobById(job.job_id)
}

export async function runPendingBackupJobs(logger = console) {
  const pendingJob = getPendingJob()
  if (!pendingJob) return null
  return processBackupJob(pendingJob, logger)
}
