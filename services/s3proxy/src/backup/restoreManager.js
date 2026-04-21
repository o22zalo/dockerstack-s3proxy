import { randomUUID } from 'crypto'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import {
  commitUploadedObjectMetadata,
  getAllAccounts,
  getAccountById,
} from '../db.js'
import { listLedgerEntries, getJobById } from './backupJournal.js'
import { createDestination } from './destinations/index.js'

export async function startRestoreJob({
  sourceJobId,
  sourceDestinationType,
  sourceDestinationConfig = {},
  targetAccountMapping = {},
  options = {},
  logger = console,
}) {
  const restoreId = `restore_${randomUUID()}`
  const { dryRun = false } = options

  const sourceJob = getJobById(sourceJobId)
  if (!sourceJob) throw new Error(`source job not found: ${sourceJobId}`)

  logger.info?.({ restoreId, sourceJobId, dryRun }, 'restore job started')

  const ledgerEntries = []
  let offset = 0
  const PAGE = 500
  while (true) {
    const page = listLedgerEntries(sourceJobId, { limit: PAGE, offset })
    const done = page.filter((e) => e.status === 'done')
    ledgerEntries.push(...done)
    if (page.length < PAGE) break
    offset += PAGE
  }

  if (ledgerEntries.length === 0) {
    return {
      restoreId,
      sourceJobId,
      status: 'completed',
      totalObjects: 0,
      restoredObjects: 0,
      failedObjects: 0,
      dryRun,
      message: 'No completed objects found in source job ledger',
    }
  }

  const sourceDest = createDestination(sourceDestinationType, sourceDestinationConfig)
  const allAccounts = getAllAccounts()
  const accountById = Object.fromEntries(allAccounts.map((a) => [a.account_id, a]))

  let restored = 0
  let failed = 0
  const errors = []
  const clientCache = new Map()
  const getOrCreateClient = (account) => {
    if (clientCache.has(account.account_id)) return clientCache.get(account.account_id)
    const client = new S3Client({
      endpoint: account.endpoint,
      region: account.region || 'us-east-1',
      credentials: {
        accessKeyId: account.access_key_id,
        secretAccessKey: account.secret_key,
      },
      forcePathStyle: true,
    })
    clientCache.set(account.account_id, client)
    return client
  }

  for (const entry of ledgerEntries) {
    const targetAccountId = targetAccountMapping[entry.account_id] ?? entry.account_id
    const targetAccount = accountById[targetAccountId] ?? getAccountById(targetAccountId)

    if (!targetAccount) {
      const err = `target account not found: ${targetAccountId} (mapped from ${entry.account_id})`
      logger.warn?.({ entry, err }, 'restore: skipping entry')
      errors.push({ backendKey: entry.backend_key, error: err })
      failed += 1
      continue
    }

    try {
      if (dryRun) {
        logger.info?.({ key: entry.dst_key, targetAccountId }, 'restore: dry-run skip')
        restored += 1
        continue
      }

      const readStream = await sourceDest.read(entry.dst_key)
      const contentType = entry.content_type || 'application/octet-stream'
      const sizeBytes = Number(entry.src_size_bytes || 0)
      const client = getOrCreateClient(targetAccount)

      await client.send(new PutObjectCommand({
        Bucket: targetAccount.bucket,
        Key: entry.backend_key,
        Body: readStream,
        ContentType: contentType,
        ContentLength: sizeBytes > 0 ? sizeBytes : undefined,
      }))

      commitUploadedObjectMetadata({
        encoded_key: entry.encoded_key,
        account_id: targetAccountId,
        bucket: entry.backend_bucket || targetAccount.bucket,
        object_key: entry.backend_key,
        backend_key: entry.backend_key,
        size_bytes: sizeBytes,
        content_type: contentType,
        etag: entry.src_etag || '',
      })

      restored += 1
      logger.info?.({ restoreId, key: entry.backend_key, targetAccountId, sizeBytes }, 'restore: object restored')
    } catch (err) {
      failed += 1
      errors.push({ backendKey: entry.backend_key, error: err.message })
      logger.error?.({ restoreId, key: entry.backend_key, err: err.message }, 'restore: object failed')
    }
  }

  const result = {
    restoreId,
    sourceJobId,
    status: failed > 0 ? 'completed_with_errors' : 'completed',
    totalObjects: ledgerEntries.length,
    restoredObjects: restored,
    failedObjects: failed,
    dryRun,
    errors: errors.slice(0, 50),
  }

  logger.info?.(result, 'restore job finished')
  return result
}

export async function verifyRestoreIntegrity(jobId, sourceDestination) {
  const sourceJob = getJobById(jobId)
  if (!sourceJob) return { jobId, status: 'error', error: 'job_not_found', mismatches: [] }

  const ledgerEntries = listLedgerEntries(jobId, { limit: 1000, offset: 0 })
  const doneEntries = ledgerEntries.filter((e) => e.status === 'done')

  const mismatches = []
  for (const entry of doneEntries) {
    if (!sourceDestination) break
    try {
      const meta = await sourceDestination.getMetadata(entry.dst_key)
      if (entry.src_etag && meta.etag && entry.src_etag !== meta.etag) {
        mismatches.push({
          backendKey: entry.backend_key,
          expectedEtag: entry.src_etag,
          actualEtag: meta.etag,
        })
      }
    } catch (err) {
      mismatches.push({ backendKey: entry.backend_key, error: err.message })
    }
  }

  return {
    jobId,
    status: mismatches.length === 0 ? 'ok' : 'mismatches_found',
    checkedObjects: doneEntries.length,
    mismatches,
  }
}
