import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { createS3Client } from '../inventoryScanner.js'
import config from '../config.js'
import { findLedgerByEtag, markLedgerDone, markLedgerFailed } from './backupJournal.js'

function toPlainEtag(value) {
  return String(value || '').replace(/"/g, '')
}

export async function copyObjectToDestination({
  account,
  backendKey,
  encodedKey,
  jobId,
  destination,
  destinationType = 'local',
  options = {},
  signal,
  logger,
}) {
  const client = createS3Client(account)
  let attempt = 0

  while (attempt < 3) {
    attempt += 1
    try {
      const head = await client.send(new HeadObjectCommand({ Bucket: account.bucket, Key: backendKey }))
      const etag = toPlainEtag(head.ETag)
      const sizeBytes = Number(head.ContentLength || 0)
      const contentType = head.ContentType || 'application/octet-stream'
      const maxAllowedBytes = Math.max(1, Number(config.BACKUP_MAX_OBJECT_SIZE_MB || 512)) * 1024 * 1024
      if (sizeBytes > maxAllowedBytes) {
        return { status: 'skipped', error: `object_too_large:${sizeBytes}` }
      }

      if (options.skipExistingByEtag && etag) {
        const existing = findLedgerByEtag(jobId, account.account_id, backendKey, destinationType, etag)
        if (existing) {
          return { status: 'skipped', etag, sizeBytes, dstKey: existing.dst_key, dstLocation: existing.dst_location }
        }
      }

      if (options.dryRun) {
        return { status: 'done', etag, sizeBytes, dstKey: null, dstLocation: 'dry-run' }
      }

      const bodyRes = await client.send(new GetObjectCommand({ Bucket: account.bucket, Key: backendKey }))
      const backupDate = new Date().toISOString().slice(0, 10)
      const dstKey = `backup/${jobId}/${backupDate}/${account.account_id}/${account.bucket}/${backendKey}`
      const uploadResult = await destination.upload({
        stream: bodyRes.Body,
        key: dstKey,
        contentType,
        size: sizeBytes,
        etag,
        signal,
      })

      markLedgerDone({
        job_id: jobId,
        account_id: account.account_id,
        backend_key: backendKey,
        destination_type: destinationType,
        dst_key: uploadResult.key || dstKey,
        dst_location: uploadResult.location,
        completed_at: Date.now(),
      })

      return {
        status: 'done',
        dstKey: uploadResult.key || dstKey,
        dstLocation: uploadResult.location,
        etag,
        sizeBytes,
      }
    } catch (err) {
      const statusCode = Number(err?.$metadata?.httpStatusCode || err?.statusCode || 0)
      if (statusCode === 404 || err?.name === 'NotFound') {
        return { status: 'skipped', error: 'source_object_not_found' }
      }
      markLedgerFailed({
        job_id: jobId,
        account_id: account.account_id,
        backend_key: backendKey,
        destination_type: destinationType,
        error: err.message,
        attempt_count: attempt,
        last_attempt_at: Date.now(),
      })

      if (attempt >= 3) {
        logger?.error?.({ err: err.message, jobId, backendKey }, 'backup copy failed')
        return { status: 'failed', error: err.message }
      }

      await new Promise((resolve) => setTimeout(resolve, 100 * (2 ** attempt)))
    }
  }

  return { status: 'failed', error: 'unknown error' }
}
