import { randomUUID } from 'crypto'
import { db } from '../db.js'
import { backupRtdbDelete, backupRtdbPatch, backupRtdbSet } from './backupFirebase.js'

const RTDB_FLUSH_INTERVAL_MS = 2000
const syncTimers = new Map()
const pendingProgress = new Map()
let warnedMissingBackupRtdb = false

const stmts = {
  createJob: db.prepare(`
    INSERT INTO backup_jobs (
      job_id, type, status, created_at, destination_type, destination_config_json,
      account_filter_json, options_json
    ) VALUES (
      @job_id, @type, @status, @created_at, @destination_type, @destination_config_json,
      @account_filter_json, @options_json
    )
  `),
  updateJobStatus: db.prepare(`
    UPDATE backup_jobs
    SET status=@status,
        started_at=@started_at,
        completed_at=@completed_at,
        last_error=@last_error,
        resume_token=@resume_token,
        running_instance_id=@running_instance_id,
        running_heartbeat_at=@running_heartbeat_at
    WHERE job_id=@job_id
  `),
  touchJobHeartbeat: db.prepare(`
    UPDATE backup_jobs
    SET running_instance_id=@running_instance_id,
        running_heartbeat_at=@running_heartbeat_at
    WHERE job_id=@job_id
  `),
  updateJobProgress: db.prepare(`
    UPDATE backup_jobs
    SET total_objects=@total_objects,
        done_objects=@done_objects,
        failed_objects=@failed_objects,
        total_bytes=@total_bytes,
        done_bytes=@done_bytes,
        last_error=@last_error
    WHERE job_id=@job_id
  `),
  getJobById: db.prepare('SELECT * FROM backup_jobs WHERE job_id = ?'),
  getRunningJob: db.prepare("SELECT * FROM backup_jobs WHERE status='running' ORDER BY created_at ASC LIMIT 1"),
  getPendingJob: db.prepare("SELECT * FROM backup_jobs WHERE status='pending' ORDER BY created_at ASC LIMIT 1"),
  claimPendingJob: db.prepare(`
    UPDATE backup_jobs
    SET status='running', started_at=COALESCE(started_at, @started_at)
    WHERE job_id=@job_id AND status='pending'
  `),
  listJobs: db.prepare('SELECT * FROM backup_jobs ORDER BY created_at DESC LIMIT @limit OFFSET @offset'),
  listJobsByStatus: db.prepare('SELECT * FROM backup_jobs WHERE status=@status ORDER BY created_at DESC LIMIT @limit OFFSET @offset'),
  upsertLedger: db.prepare(`
    INSERT INTO backup_ledger (
      job_id, account_id, backend_bucket, backend_key, encoded_key, destination_type, status,
      src_etag, src_size_bytes
    ) VALUES (
      @job_id, @account_id, @backend_bucket, @backend_key, @encoded_key, @destination_type, @status,
      @src_etag, @src_size_bytes
    )
    ON CONFLICT(job_id, account_id, backend_key, destination_type) DO UPDATE SET
      status=excluded.status,
      src_etag=COALESCE(excluded.src_etag, backup_ledger.src_etag),
      src_size_bytes=COALESCE(excluded.src_size_bytes, backup_ledger.src_size_bytes)
  `),
  markLedgerDone: db.prepare(`
    UPDATE backup_ledger
    SET status='done',
        dst_key=@dst_key,
        dst_location=@dst_location,
        completed_at=@completed_at,
        error=NULL
    WHERE job_id=@job_id AND account_id=@account_id AND backend_key=@backend_key AND destination_type=@destination_type
  `),
  markLedgerFailed: db.prepare(`
    UPDATE backup_ledger
    SET status='failed',
        error=@error,
        attempt_count=@attempt_count,
        last_attempt_at=@last_attempt_at
    WHERE job_id=@job_id AND account_id=@account_id AND backend_key=@backend_key AND destination_type=@destination_type
  `),
  markLedgerSkipped: db.prepare(`
    UPDATE backup_ledger
    SET status='skipped',
        error=@error,
        completed_at=@completed_at
    WHERE job_id=@job_id AND account_id=@account_id AND backend_key=@backend_key AND destination_type=@destination_type
  `),
  getPendingLedgerEntries: db.prepare(`
    SELECT * FROM backup_ledger
    WHERE job_id=@job_id AND status IN ('pending','failed') AND id > @after_id
    ORDER BY id ASC
    LIMIT @limit
  `),
  findLedgerByEtag: db.prepare(`
    SELECT * FROM backup_ledger
    WHERE job_id=@job_id AND account_id=@account_id AND backend_key=@backend_key
      AND destination_type=@destination_type
      AND src_etag=@etag AND status='done'
    LIMIT 1
  `),
  deleteJob: db.prepare('DELETE FROM backup_jobs WHERE job_id=@job_id'),
  deleteLedgerByJob: db.prepare('DELETE FROM backup_ledger WHERE job_id=@job_id'),
  listLedgerByJob: db.prepare(`
    SELECT * FROM backup_ledger
    WHERE job_id=@job_id
    ORDER BY id DESC
    LIMIT @limit OFFSET @offset
  `),
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback
  } catch {
    return fallback
  }
}

function normalizeJob(row) {
  if (!row) return null
  return {
    ...row,
    destination_config: parseJson(row.destination_config_json, {}),
    account_filter: parseJson(row.account_filter_json, []),
    options: parseJson(row.options_json, {}),
    progress: {
      totalObjects: row.total_objects,
      doneObjects: row.done_objects,
      failedObjects: row.failed_objects,
      totalBytes: row.total_bytes,
      doneBytes: row.done_bytes,
    },
  }
}

export async function createBackupJob({ type = 'full', destinationType, destinationConfig = {}, accountFilter = [], options = {} }) {
  const jobId = `job_${randomUUID()}`
  const createdAt = Date.now()
  stmts.createJob.run({
    job_id: jobId,
    type,
    status: 'pending',
    created_at: createdAt,
    destination_type: destinationType,
    destination_config_json: JSON.stringify(destinationConfig ?? {}),
    account_filter_json: JSON.stringify(accountFilter ?? []),
    options_json: JSON.stringify(options ?? {}),
  })

  await backupRtdbSet(`jobs/${jobId}`, {
    status: 'pending',
    type,
    createdAt,
    destinationType,
    progress: { totalObjects: 0, doneObjects: 0, failedObjects: 0, totalBytes: 0, doneBytes: 0 },
  }).catch((err) => {
    console.warn(`[backup] create job sync to RTDB failed: ${err.message}`)
  })

  return getJobById(jobId)
}

function ensureBackupRtdbWarning() {
  if (warnedMissingBackupRtdb) return
  if (process.env.BACKUP_RTDB_URL || process.env.S3PROXY_BACKUP_RTDB_URL) return
  warnedMissingBackupRtdb = true
  console.warn('[backup] BACKUP_RTDB_URL is empty; progress/status will only persist in SQLite')
}

export async function updateJobStatus(jobId, status, extras = {}) {
  const current = stmts.getJobById.get(jobId)
  const startedAt = Object.prototype.hasOwnProperty.call(extras, 'startedAt') ? extras.startedAt : current?.started_at ?? null
  const completedAt = Object.prototype.hasOwnProperty.call(extras, 'completedAt') ? extras.completedAt : current?.completed_at ?? null
  const lastError = Object.prototype.hasOwnProperty.call(extras, 'lastError') ? extras.lastError : current?.last_error ?? null
  const resumeToken = Object.prototype.hasOwnProperty.call(extras, 'resumeToken')
    ? (extras.resumeToken === null ? null : JSON.stringify(extras.resumeToken))
    : current?.resume_token ?? null
  const runningInstanceId = Object.prototype.hasOwnProperty.call(extras, 'runningInstanceId')
    ? extras.runningInstanceId
    : current?.running_instance_id ?? null
  const runningHeartbeatAt = Object.prototype.hasOwnProperty.call(extras, 'runningHeartbeatAt')
    ? extras.runningHeartbeatAt
    : current?.running_heartbeat_at ?? null
  stmts.updateJobStatus.run({
    job_id: jobId,
    status,
    started_at: startedAt,
    completed_at: completedAt,
    last_error: lastError,
    resume_token: resumeToken,
    running_instance_id: runningInstanceId,
    running_heartbeat_at: runningHeartbeatAt,
  })
  await backupRtdbPatch(`jobs/${jobId}`, {
    status,
    startedAt: extras.startedAt,
    completedAt: extras.completedAt,
    lastError: extras.lastError ?? null,
  }).catch((err) => {
    console.warn(`[backup] update status sync to RTDB failed: ${err.message}`)
  })
}

export async function updateJobProgress(jobId, progress) {
  stmts.updateJobProgress.run({
    job_id: jobId,
    total_objects: progress.totalObjects ?? 0,
    done_objects: progress.doneObjects ?? 0,
    failed_objects: progress.failedObjects ?? 0,
    total_bytes: progress.totalBytes ?? 0,
    done_bytes: progress.doneBytes ?? 0,
    last_error: progress.lastError ?? null,
  })
  ensureBackupRtdbWarning()
  await syncProgressToRtdb(jobId, progress)
}

export async function syncProgressToRtdb(jobId, snapshot) {
  pendingProgress.set(jobId, snapshot)
  if (syncTimers.has(jobId)) return

  syncTimers.set(jobId, setTimeout(async () => {
    const payload = pendingProgress.get(jobId)
    pendingProgress.delete(jobId)
    syncTimers.delete(jobId)
    try {
      await backupRtdbPatch(`jobs/${jobId}/progress`, payload)
    } catch (err) {
      console.warn(`[backup] failed syncing progress to RTDB for job ${jobId}: ${err.message}`)
    }
  }, RTDB_FLUSH_INTERVAL_MS))
}

export function upsertLedgerEntry(entry) { stmts.upsertLedger.run(entry) }
export function markLedgerDone(entry) { stmts.markLedgerDone.run(entry) }
export function markLedgerFailed(entry) { stmts.markLedgerFailed.run(entry) }
export function markLedgerSkipped(entry) { stmts.markLedgerSkipped.run(entry) }
export function touchJobHeartbeat(jobId, { instanceId, heartbeatAt = Date.now() } = {}) {
  stmts.touchJobHeartbeat.run({
    job_id: jobId,
    running_instance_id: instanceId ?? null,
    running_heartbeat_at: heartbeatAt,
  })
}
export function getPendingLedgerEntries(jobId, { limit = 100, afterId = 0 } = {}) {
  return stmts.getPendingLedgerEntries.all({ job_id: jobId, limit, after_id: afterId })
}
export function findLedgerByEtag(jobId, accountId, backendKey, destinationType, etag) {
  return stmts.findLedgerByEtag.get({
    job_id: jobId,
    account_id: accountId,
    backend_key: backendKey,
    destination_type: destinationType,
    etag,
  })
}
export function getRunningJob() { return normalizeJob(stmts.getRunningJob.get()) }
export function getPendingJob() { return normalizeJob(stmts.getPendingJob.get()) }
export function claimNextPendingJob() {
  const row = stmts.getPendingJob.get()
  if (!row) return null
  const changes = stmts.claimPendingJob.run({ job_id: row.job_id, started_at: Date.now() }).changes
  if (changes === 0) return null
  return normalizeJob(stmts.getJobById.get(row.job_id))
}
export function getJobById(jobId) { return normalizeJob(stmts.getJobById.get(jobId)) }
export function listJobs({ limit = 20, offset = 0, status } = {}) {
  const rows = status
    ? stmts.listJobsByStatus.all({ status, limit, offset })
    : stmts.listJobs.all({ limit, offset })
  return rows.map(normalizeJob)
}

export function listLedgerEntries(jobId, { limit = 200, offset = 0 } = {}) {
  return stmts.listLedgerByJob.all({ job_id: jobId, limit, offset })
}

export function deleteJobById(jobId) {
  stmts.deleteLedgerByJob.run({ job_id: jobId })
  stmts.deleteJob.run({ job_id: jobId })
  backupRtdbDelete(`jobs/${jobId}`).catch(() => {})
}
