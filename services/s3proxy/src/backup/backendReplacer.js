import { randomUUID } from 'crypto'
import {
  getAccountById,
  upsertAccount,
  getAllAccounts,
  getTrackedRoutesByAccount,
  commitUploadedObjectMetadata,
} from '../db.js'
import {
  S3Client,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3'

function makeS3Client(account) {
  return new S3Client({
    endpoint: account.endpoint,
    region: account.region || 'us-east-1',
    credentials: {
      accessKeyId: account.access_key_id,
      secretAccessKey: account.secret_key,
    },
    forcePathStyle: true,
  })
}

export async function checkBackendHealth(account) {
  const startedAt = Date.now()
  if (!account?.endpoint || !account?.bucket) {
    return { ok: false, latencyMs: 0, error: 'missing endpoint/bucket config' }
  }

  try {
    const client = makeS3Client(account)
    await client.send(new HeadBucketCommand({ Bucket: account.bucket }))
    await client.send(new ListObjectsV2Command({ Bucket: account.bucket, MaxKeys: 1 }))
    return { ok: true, latencyMs: Date.now() - startedAt, error: null }
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: err.message,
      code: err?.name || err?.$metadata?.httpStatusCode,
    }
  }
}

export async function replaceBackendConfig(sourceAccountId, newAccountConfig, { dryRun = false } = {}) {
  const migrationId = `mig_${randomUUID()}`
  const existing = getAccountById(sourceAccountId)
  if (!existing) throw new Error(`account not found: ${sourceAccountId}`)

  const rollbackSnapshot = { ...existing }

  if (dryRun) {
    return {
      migrationId,
      migrationType: 'replace_config',
      sourceAccountId,
      dryRun: true,
      status: 'dry_run',
      rollbackAvailable: false,
      newConfig: newAccountConfig,
    }
  }

  upsertAccount({
    ...existing,
    ...newAccountConfig,
    account_id: sourceAccountId,
  })

  return {
    migrationId,
    migrationType: 'replace_config',
    sourceAccountId,
    dryRun: false,
    status: 'completed',
    rollbackAvailable: true,
    rollbackSnapshot,
  }
}

export async function migrateBackendObjects(sourceAccountId, targetAccountId, options = {}, logger = console) {
  const { dryRun = false, deleteSource = false, skipExistingByEtag = true, concurrency = 3 } = options
  const migrationId = `mig_${randomUUID()}`

  const sourceAccount = getAccountById(sourceAccountId)
  if (!sourceAccount) throw new Error(`source account not found: ${sourceAccountId}`)

  const targetAccount = getAccountById(targetAccountId)
  if (!targetAccount) throw new Error(`target account not found: ${targetAccountId}`)

  const routes = getTrackedRoutesByAccount(sourceAccountId)
  logger.info?.({ migrationId, sourceAccountId, targetAccountId, routeCount: routes.length, dryRun }, 'migrate started')

  const sourceClient = makeS3Client(sourceAccount)
  const targetClient = makeS3Client(targetAccount)

  let done = 0
  let failed = 0
  const errors = []

  let inflight = 0
  const wait = () => new Promise((resolve) => setTimeout(resolve, 50))

  const migrateOne = async (route) => {
    try {
      if (dryRun) {
        done += 1
        return
      }

      if (skipExistingByEtag && route.etag) {
        try {
          const head = await targetClient.send(new HeadObjectCommand({
            Bucket: targetAccount.bucket,
            Key: route.backend_key,
          }))
          const targetEtag = String(head.ETag || '').replace(/"/g, '')
          if (targetEtag && targetEtag === String(route.etag || '').replace(/"/g, '')) {
            done += 1
            return
          }
        } catch {
          // continue copy
        }
      }

      const getRes = await sourceClient.send(new GetObjectCommand({
        Bucket: sourceAccount.bucket,
        Key: route.backend_key,
      }))

      const chunks = []
      for await (const chunk of getRes.Body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      }
      const body = Buffer.concat(chunks)

      await targetClient.send(new PutObjectCommand({
        Bucket: targetAccount.bucket,
        Key: route.backend_key,
        Body: body,
        ContentType: getRes.ContentType || 'application/octet-stream',
      }))

      commitUploadedObjectMetadata({
        encoded_key: route.encoded_key,
        account_id: targetAccountId,
        bucket: targetAccount.bucket,
        object_key: route.object_key,
        backend_key: route.backend_key,
        size_bytes: route.size_bytes,
        content_type: route.content_type || 'application/octet-stream',
        etag: route.etag || '',
      })

      if (deleteSource) {
        await sourceClient.send(new DeleteObjectCommand({
          Bucket: sourceAccount.bucket,
          Key: route.backend_key,
        }))
      }

      done += 1
      logger.info?.({ migrationId, key: route.backend_key, done, total: routes.length }, 'migrate: object done')
    } catch (err) {
      failed += 1
      errors.push({ backendKey: route.backend_key, error: err.message })
      logger.error?.({ migrationId, key: route.backend_key, err: err.message }, 'migrate: object failed')
    }
  }

  const tasks = new Set()
  const effectiveConcurrency = Math.max(1, Number(concurrency) || 1)
  for (const route of routes) {
    while (inflight >= effectiveConcurrency) await wait()
    inflight += 1
    const t = migrateOne(route).finally(() => {
      inflight -= 1
      tasks.delete(t)
    })
    tasks.add(t)
  }
  await Promise.all(tasks)

  return {
    migrationId,
    migrationType: 'copy_objects',
    sourceAccountId,
    targetAccountId,
    status: failed > 0 ? 'completed_with_errors' : 'completed',
    totalObjects: routes.length,
    doneObjects: done,
    failedObjects: failed,
    dryRun,
    errors: errors.slice(0, 50),
  }
}

export async function rollbackMigration(migrationId) {
  return {
    migrationId,
    status: 'manual_required',
    message: 'Automatic rollback requires migration snapshot. Use replaceBackendConfig() với rollbackSnapshot để khôi phục config, sau đó chạy migrate theo chiều ngược lại nếu cần.',
  }
}

export async function diagnoseBackend(accountId) {
  const account = getAccountById(accountId)
  if (!account) return { accountId, healthy: false, error: 'account_not_found' }

  const health = await checkBackendHealth(account)
  const routes = getTrackedRoutesByAccount(accountId)
  const trackedBytes = routes.reduce((sum, r) => sum + Number(r.size_bytes || 0), 0)

  const allAccounts = getAllAccounts().filter((a) => a.account_id !== accountId && a.active === 1)
  const alternativeAccounts = allAccounts.map((a) => ({
    accountId: a.account_id,
    endpoint: a.endpoint,
    usedBytes: Number(a.used_bytes || 0),
    totalBytes: Number(a.total_bytes || 0),
  }))

  const suggestedActions = []
  if (!health.ok) {
    if (health.code === 403 || health.code === 401 || health.code === 'Forbidden') suggestedActions.push('replaceConfig')
    else suggestedActions.push('replaceConfig', 'migrateToOtherAccount')
  }

  return {
    accountId,
    healthy: health.ok,
    latencyMs: health.latencyMs,
    error: health.error,
    trackedObjects: routes.length,
    trackedBytes,
    suggestedActions,
    alternativeAccounts,
  }
}
