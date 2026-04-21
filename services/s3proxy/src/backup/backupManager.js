import config from '../config.js'
import { Readable } from 'stream'
import { getAllAccounts, getRouteByBackendKey } from '../db.js'
import { scanAccountInventory } from '../inventoryScanner.js'
import { encodeKey } from '../metadata.js'
import { rtdbGet } from '../firebase.js'
import {
  createBackupJob,
  deleteJobById,
  claimNextPendingJob,
  getJobById,
  listLedgerEntries,
  listJobs,
  updateJobProgress,
  updateJobStatus,
  upsertLedgerEntry,
} from './backupJournal.js'
import { createDestination } from './destinations/index.js'
import { copyObjectToDestination } from './backupWorker.js'

const activeJobs = new Map()
let managerInterval = null

export function initBackupManager(logger = console, intervalMs = 2000) {
  if (managerInterval) return { started: false }
  managerInterval = setInterval(() => {
    runPendingBackupJobs(logger).catch((err) => {
      logger?.error?.({ err: err.message }, 'backup manager tick failed')
    })
  }, intervalMs)
  managerInterval.unref?.()
  return { started: true }
}

export function stopBackupManager() {
  if (!managerInterval) return
  clearInterval(managerInterval)
  managerInterval = null
}

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
  const destinationConfig = payload?.destinationConfig || {}
  if (Array.isArray(destinationConfig.destinations) && destinationConfig.destinations.length > 0) {
    destinationConfig.destinations.forEach((item) => {
      createDestination(item.type || payload.destinationType, item.config || {})
    })
  } else {
    createDestination(payload.destinationType, destinationConfig)
  }
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

export async function pauseBackupJob(jobId) {
  const active = activeJobs.get(jobId)
  if (active) {
    active.abortController.abort('paused')
    activeJobs.delete(jobId)
  }
  await updateJobStatus(jobId, 'paused', {
    resumeToken: { pausedAt: Date.now() },
    lastError: 'paused_by_user',
  })
}

export async function resumeBackupJob(jobId) {
  const job = getJobById(jobId)
  if (!job) throw new Error('job_not_found')
  if (job.status !== 'paused' && job.status !== 'failed' && job.status !== 'cancelled') {
    return job
  }
  await updateJobStatus(jobId, 'pending', { lastError: null })
  return getJobById(jobId)
}

export function getJobLiveStatus(jobId) {
  const persisted = getJobById(jobId)
  const running = activeJobs.has(jobId)
  return {
    ...persisted,
    live: {
      running,
      inMemory: running ? 'active' : 'idle',
    },
  }
}

export function listBackupJobLedger(jobId, options = {}) {
  return listLedgerEntries(jobId, options)
}

export function removeBackupJob(jobId) {
  if (activeJobs.has(jobId)) {
    throw new Error('job_is_running')
  }
  deleteJobById(jobId)
}

export async function processBackupJob(job, logger = console) {
  if (!job) return null

  const abortController = new AbortController()
  activeJobs.set(job.job_id, { abortController })
  await updateJobStatus(job.job_id, 'running', { startedAt: Date.now() })

  const accountFilter = new Set(job.account_filter || [])
  let resumeToken = {}
  try {
    resumeToken = typeof job.resume_token === 'string'
      ? JSON.parse(job.resume_token || '{}')
      : (job.resume_token || {})
  } catch {
    resumeToken = {}
  }
  const accounts = getAllAccounts().filter((account) => account.active === 1)
  const targetAccounts = accountFilter.size > 0
    ? accounts.filter((account) => accountFilter.has(account.account_id))
    : accounts

  const destinationConfig = job.destination_config || {}
  const destinationType = job.destination_type
  const destinations = Array.isArray(destinationConfig.destinations) && destinationConfig.destinations.length > 0
    ? destinationConfig.destinations.map((item) => ({
      type: item.type || destinationType,
      adapter: createDestination(item.type || destinationType, item.config || {}),
    }))
    : [{ type: destinationType, adapter: createDestination(destinationType, destinationConfig) }]

  const progress = {
    totalObjects: 0,
    doneObjects: 0,
    failedObjects: 0,
    totalBytes: 0,
    doneBytes: 0,
    currentAccountId: null,
    currentKey: null,
    percentDone: 0,
    lastError: null,
  }
  await updateJobProgress(job.job_id, progress)

  const semaphore = buildSemaphore(Math.max(1, Number(config.BACKUP_CONCURRENCY || 3)))
  const tasks = []
  const maxObjectSizeBytes = Math.max(1, Number(config.BACKUP_MAX_OBJECT_SIZE_MB || 512)) * 1024 * 1024

  try {
    for (const account of targetAccounts) {
      if (abortController.signal.aborted) break
      if (resumeToken.accountId && resumeToken.accountId !== account.account_id) {
        continue
      }

      await scanAccountInventory(account, {
        continuationToken: resumeToken.accountId === account.account_id ? resumeToken.continuationToken : undefined,
        onPage: async ({ objects, nextContinuationToken }) => {
          for (const object of objects) {
            if (abortController.signal.aborted) break
            if ((Number(object.sizeBytes) || 0) > maxObjectSizeBytes) {
              continue
            }

            progress.totalObjects += 1
            progress.totalBytes += Number(object.sizeBytes || 0)
            progress.currentAccountId = account.account_id
            progress.currentKey = object.backendKey
            progress.percentDone = progress.totalObjects > 0
              ? Number((((progress.doneObjects + progress.failedObjects) / progress.totalObjects) * 100).toFixed(2))
              : 0

            const existingRoute = getRouteByBackendKey(account.account_id, object.backendKey)
            const encodedKey = existingRoute?.encoded_key || encodeKey(account.bucket, object.backendKey)

            await semaphore.acquire()
            const task = (async () => {
              try {
                for (const destination of destinations) {
                  upsertLedgerEntry({
                    job_id: job.job_id,
                    account_id: account.account_id,
                    backend_bucket: account.bucket,
                    backend_key: object.backendKey,
                    encoded_key: encodedKey,
                    destination_type: destination.type,
                    status: 'pending',
                    src_etag: object.etag,
                    src_size_bytes: object.sizeBytes,
                  })

                  const result = await copyObjectToDestination({
                    account,
                    backendKey: object.backendKey,
                    encodedKey,
                    jobId: job.job_id,
                    destination: destination.adapter,
                    destinationType: destination.type,
                    options: job.options,
                    signal: abortController.signal,
                    logger,
                  })

                  if (result.status === 'failed') {
                    progress.failedObjects += 1
                    progress.lastError = result.error || 'unknown copy failure'
                  } else if (result.status === 'done') {
                    progress.doneObjects += 1
                    progress.doneBytes += Number(object.sizeBytes || 0)
                  }
                }
              } finally {
                progress.percentDone = progress.totalObjects > 0
                  ? Number((((progress.doneObjects + progress.failedObjects) / progress.totalObjects) * 100).toFixed(2))
                  : 0
                await updateJobProgress(job.job_id, progress)
                semaphore.release()
              }
            })()

            tasks.push(task)
            await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(config.BACKUP_CHUNK_STREAM_MS || 50))))
          }

          await updateJobStatus(job.job_id, 'running', {
            resumeToken: {
              accountId: account.account_id,
              continuationToken: nextContinuationToken || null,
              lastKey: objects.at(-1)?.backendKey || null,
            },
          })
        },
      })

      await updateJobStatus(job.job_id, 'running', {
        resumeToken: {
          accountId: account.account_id,
          continuationToken: null,
          lastKey: null,
        },
      })
    }

    await Promise.all(tasks)

    if (job.options?.includeRtdb) {
      const snapshot = {
        routes: await rtdbGet('/routes').catch(() => null),
        accounts: await rtdbGet('/accounts').catch(() => null),
        exportedAt: Date.now(),
      }
      for (const destination of destinations) {
        await destination.adapter.upload({
          stream: Readable.from([JSON.stringify(snapshot)]),
          key: `backup/${job.job_id}/${new Date().toISOString().slice(0, 10)}/rtdb-snapshot.json`,
          contentType: 'application/json',
          size: Buffer.byteLength(JSON.stringify(snapshot)),
          signal: abortController.signal,
        })
      }
    }
  } catch (err) {
    progress.failedObjects += 1
    progress.lastError = err.message
    await updateJobProgress(job.job_id, progress)
    await updateJobStatus(job.job_id, 'failed', { completedAt: Date.now(), lastError: err.message })
    activeJobs.delete(job.job_id)
    return getJobById(job.job_id)
  }

  await updateJobProgress(job.job_id, progress)

  if (abortController.signal.aborted) {
    const latest = getJobById(job.job_id)
    if (latest?.status === 'paused') {
      await updateJobStatus(job.job_id, 'paused', { lastError: latest.last_error ?? 'paused_by_user' })
    } else if (latest?.status === 'cancelled') {
      await updateJobStatus(job.job_id, 'cancelled', { completedAt: Date.now(), lastError: latest.last_error ?? 'cancelled' })
    } else {
      await updateJobStatus(job.job_id, 'cancelled', { completedAt: Date.now(), lastError: 'cancelled' })
    }
  } else if (progress.failedObjects > 0) {
    await updateJobStatus(job.job_id, 'failed', { completedAt: Date.now(), lastError: progress.lastError || 'some objects failed' })
  } else {
    await updateJobStatus(job.job_id, 'completed', { completedAt: Date.now() })
  }

  activeJobs.delete(job.job_id)
  return getJobById(job.job_id)
}

export async function runPendingBackupJobs(logger = console) {
  const pendingJob = claimNextPendingJob()
  if (!pendingJob) return null
  return processBackupJob(pendingJob, logger)
}
