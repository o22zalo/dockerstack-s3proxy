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
  getPendingLedgerEntries,
  getRunningJob,
  listLedgerEntries,
  listJobs,
  markLedgerSkipped,
  touchJobHeartbeat,
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
  const staleRunning = getRunningJob()
  if (staleRunning) {
    updateJobStatus(staleRunning.job_id, 'pending', {
      completedAt: null,
      lastError: 'auto_resumed_after_restart',
    }).catch(() => {})
  }
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
  if (active) active.abortController.abort('cancelled')
  await updateJobStatus(jobId, 'cancelled', { lastError: 'cancelled_by_user' })
}

export async function pauseBackupJob(jobId) {
  const active = activeJobs.get(jobId)
  if (active) active.abortController.abort('paused')
  await updateJobStatus(jobId, 'paused', { lastError: 'paused_by_user' })
}

export async function resumeBackupJob(jobId) {
  const job = getJobById(jobId)
  if (!job) throw new Error('job_not_found')
  if (job.status !== 'paused' && job.status !== 'failed' && job.status !== 'cancelled') {
    return job
  }
  await updateJobStatus(jobId, 'pending', { completedAt: null, lastError: null })
  return getJobById(jobId)
}

export function getJobLiveStatus(jobId) {
  const persisted = getJobById(jobId)
  const running = activeJobs.has(jobId)
  return {
    ...persisted,
    live: {
      running: persisted?.status === 'running',
      inMemory: running ? 'active' : 'idle',
    },
  }
}

export function listBackupJobLedger(jobId, options = {}) {
  return listLedgerEntries(jobId, options)
}

export function removeBackupJob(jobId) {
  const persisted = getJobById(jobId)
  const heartbeatFresh = persisted?.running_heartbeat_at
    && (Date.now() - Number(persisted.running_heartbeat_at) < 15_000)
  if (activeJobs.has(jobId) || persisted?.status === 'running' || heartbeatFresh) {
    throw new Error('job_is_running')
  }
  deleteJobById(jobId)
}

export async function processBackupJob(job, logger = console) {
  if (!job) return null

  const abortController = new AbortController()
  activeJobs.set(job.job_id, { abortController })
  await updateJobStatus(job.job_id, 'running', {
    startedAt: Date.now(),
    runningInstanceId: config.INSTANCE_ID,
    runningHeartbeatAt: Date.now(),
  })

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
  const inFlight = new Set()
  const maxObjectSizeBytes = Math.max(1, Number(config.BACKUP_MAX_OBJECT_SIZE_MB || 512)) * 1024 * 1024

  const shouldStopFromDb = async () => {
    const latest = getJobById(job.job_id)
    if (!latest) return true
    if (latest.status === 'paused' || latest.status === 'cancelled') return true
    return false
  }
  const statusPollTimer = setInterval(() => {
    shouldStopFromDb()
      .then((shouldStop) => {
        if (shouldStop) abortController.abort('db_status_stop')
      })
      .catch(() => {})
  }, 1000)
  statusPollTimer.unref?.()
  const heartbeatTimer = setInterval(() => {
    touchJobHeartbeat(job.job_id, { instanceId: config.INSTANCE_ID, heartbeatAt: Date.now() })
  }, 2000)
  heartbeatTimer.unref?.()

  try {
    const ledgerSeed = getPendingLedgerEntries(job.job_id, { limit: 2000, afterId: 0 })
    const ledgerProcessedKeys = new Set()
    for (const entry of ledgerSeed) {
      if (abortController.signal.aborted) break
      const account = targetAccounts.find((item) => item.account_id === entry.account_id)
      if (!account) continue
      ledgerProcessedKeys.add(`${entry.account_id}::${entry.backend_key}`)
      progress.totalObjects += 1
      progress.totalBytes += Number(entry.src_size_bytes || 0)
      progress.currentAccountId = account.account_id
      progress.currentKey = entry.backend_key

      let hasFailedDestination = false
      let hasDoneDestination = false
      for (const destination of destinations) {
        const result = await copyObjectToDestination({
          account,
          backendKey: entry.backend_key,
          encodedKey: entry.encoded_key,
          jobId: job.job_id,
          destination: destination.adapter,
          destinationType: destination.type,
          options: job.options,
          signal: abortController.signal,
          logger,
        })
        if (result.status === 'failed') hasFailedDestination = true
        if (result.status === 'done' || result.status === 'skipped') hasDoneDestination = true
      }
      if (hasFailedDestination) progress.failedObjects += 1
      else if (hasDoneDestination) {
        progress.doneObjects += 1
        progress.doneBytes += Number(entry.src_size_bytes || 0)
      }
      progress.percentDone = progress.totalObjects > 0
        ? Number((((progress.doneObjects + progress.failedObjects) / progress.totalObjects) * 100).toFixed(2))
        : 0
      await updateJobProgress(job.job_id, progress)
    }

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
            if (await shouldStopFromDb()) {
              abortController.abort('db_status_stop')
              break
            }
            if (ledgerProcessedKeys.has(`${account.account_id}::${object.backendKey}`)) {
              continue
            }
            if (resumeToken.lastKey && !resumeToken.continuationToken && resumeToken.accountId === account.account_id) {
              if (object.backendKey <= resumeToken.lastKey) continue
            }
            if ((Number(object.sizeBytes) || 0) > maxObjectSizeBytes) {
              progress.totalObjects += 1
              progress.currentAccountId = account.account_id
              progress.currentKey = object.backendKey
              for (const destination of destinations) {
                upsertLedgerEntry({
                  job_id: job.job_id,
                  account_id: account.account_id,
                  backend_bucket: account.bucket,
                  backend_key: object.backendKey,
                  encoded_key: encodeKey(account.bucket, object.backendKey),
                  destination_type: destination.type,
                  status: 'pending',
                  src_etag: object.etag,
                  src_size_bytes: object.sizeBytes,
                })
                markLedgerSkipped({
                  job_id: job.job_id,
                  account_id: account.account_id,
                  backend_key: object.backendKey,
                  destination_type: destination.type,
                  error: `object_too_large:${object.sizeBytes}`,
                  completed_at: Date.now(),
                })
              }
              progress.doneObjects += 1
              progress.percentDone = progress.totalObjects > 0
                ? Number((((progress.doneObjects + progress.failedObjects) / progress.totalObjects) * 100).toFixed(2))
                : 0
              await updateJobProgress(job.job_id, progress)
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
                let hasFailedDestination = false
                let hasDoneDestination = false
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
                    hasFailedDestination = true
                    progress.lastError = result.error || 'unknown copy failure'
                  } else if (result.status === 'done' || result.status === 'skipped') {
                    hasDoneDestination = true
                  }
                }
                if (hasFailedDestination) {
                  progress.failedObjects += 1
                } else if (hasDoneDestination) {
                  progress.doneObjects += 1
                  progress.doneBytes += Number(object.sizeBytes || 0)
                }
              } finally {
                progress.percentDone = progress.totalObjects > 0
                  ? Number((((progress.doneObjects + progress.failedObjects) / progress.totalObjects) * 100).toFixed(2))
                  : 0
                await updateJobProgress(job.job_id, progress)
                semaphore.release()
              }
            })()
            inFlight.add(task)
            task.finally(() => inFlight.delete(task))
            if (inFlight.size >= Math.max(2, Number(config.BACKUP_CONCURRENCY || 3) * 4)) {
              await Promise.race(inFlight)
            }
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

    await Promise.all(inFlight)

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
    await updateJobStatus(job.job_id, 'failed', {
      completedAt: Date.now(),
      lastError: err.message,
      runningInstanceId: null,
      runningHeartbeatAt: null,
    })
    activeJobs.delete(job.job_id)
    return getJobById(job.job_id)
  } finally {
    clearInterval(statusPollTimer)
    clearInterval(heartbeatTimer)
  }

  await updateJobProgress(job.job_id, progress)

  if (abortController.signal.aborted) {
    const latest = getJobById(job.job_id)
    if (latest?.status === 'paused') {
      await updateJobStatus(job.job_id, 'paused', {
        lastError: latest.last_error ?? 'paused_by_user',
        runningInstanceId: null,
        runningHeartbeatAt: null,
      })
    } else if (latest?.status === 'cancelled') {
      await updateJobStatus(job.job_id, 'cancelled', {
        completedAt: Date.now(),
        lastError: latest.last_error ?? 'cancelled',
        runningInstanceId: null,
        runningHeartbeatAt: null,
      })
    } else {
      await updateJobStatus(job.job_id, 'cancelled', {
        completedAt: Date.now(),
        lastError: 'cancelled',
        runningInstanceId: null,
        runningHeartbeatAt: null,
      })
    }
  } else if (progress.failedObjects > 0) {
    await updateJobStatus(job.job_id, 'failed', {
      completedAt: Date.now(),
      lastError: progress.lastError || 'some objects failed',
      runningInstanceId: null,
      runningHeartbeatAt: null,
    })
  } else {
    await updateJobStatus(job.job_id, 'completed', {
      completedAt: Date.now(),
      runningInstanceId: null,
      runningHeartbeatAt: null,
    })
  }

  touchJobHeartbeat(job.job_id, { instanceId: null, heartbeatAt: null })

  activeJobs.delete(job.job_id)
  return getJobById(job.job_id)
}

export async function runPendingBackupJobs(logger = console) {
  if (activeJobs.size > 0) return null
  const running = getRunningJob()
  if (running && !activeJobs.has(running.job_id)) return null
  const pendingJob = claimNextPendingJob()
  if (!pendingJob) return null
  return processBackupJob(pendingJob, logger)
}
