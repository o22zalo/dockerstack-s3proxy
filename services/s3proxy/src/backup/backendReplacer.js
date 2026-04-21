import { randomUUID } from 'crypto'
import {
  getAccountById,
  upsertAccount,
  getAllAccounts,
  getTrackedRoutesByAccount,
  commitUploadedObjectMetadata,
  db,
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

const stmts = {
  insertMigration: db.prepare(`
    INSERT INTO backend_migrations (
      migration_id, type, status, source_account_id, target_account_id,
      created_at, started_at, total_objects, options_json
    ) VALUES (
      @migration_id, @type, @status, @source_account_id, @target_account_id,
      @created_at, @started_at, @total_objects, @options_json
    )
  `),
  updateMigration: db.prepare(`
    UPDATE backend_migrations
    SET status=@status,
        completed_at=@completed_at,
        done_objects=@done_objects,
        failed_objects=@failed_objects,
        rollback_json=@rollback_json
    WHERE migration_id=@migration_id
  `),
  getMigration: db.prepare('SELECT * FROM backend_migrations WHERE migration_id = ?'),
  listMigrations: db.prepare('SELECT * FROM backend_migrations ORDER BY created_at DESC LIMIT @limit OFFSET @offset'),
}

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
  const createdAt = Date.now()

  stmts.insertMigration.run({
    migration_id: migrationId,
    type: 'replace_config',
    status: dryRun ? 'dry_run' : 'running',
    source_account_id: sourceAccountId,
    target_account_id: sourceAccountId,
    created_at: createdAt,
    started_at: createdAt,
    total_objects: 0,
    options_json: JSON.stringify({ dryRun }),
  })

  if (dryRun) {
    stmts.updateMigration.run({
      migration_id: migrationId,
      status: 'dry_run',
      completed_at: Date.now(),
      done_objects: 0,
      failed_objects: 0,
      rollback_json: null,
    })
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

  stmts.updateMigration.run({
    migration_id: migrationId,
    status: 'completed',
    completed_at: Date.now(),
    done_objects: 0,
    failed_objects: 0,
    rollback_json: JSON.stringify(rollbackSnapshot),
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
  stmts.insertMigration.run({
    migration_id: migrationId,
    type: 'copy_objects',
    status: 'running',
    source_account_id: sourceAccountId,
    target_account_id: targetAccountId,
    created_at: Date.now(),
    started_at: Date.now(),
    total_objects: routes.length,
    options_json: JSON.stringify({ dryRun, deleteSource, skipExistingByEtag, concurrency }),
  })
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

      const headRes = await sourceClient.send(new HeadObjectCommand({
        Bucket: sourceAccount.bucket,
        Key: route.backend_key,
      }))
      const objectSize = Number(headRes.ContentLength || 0)
      const contentType = headRes.ContentType || 'application/octet-stream'

      const getRes = await sourceClient.send(new GetObjectCommand({
        Bucket: sourceAccount.bucket,
        Key: route.backend_key,
      }))

      await targetClient.send(new PutObjectCommand({
        Bucket: targetAccount.bucket,
        Key: route.backend_key,
        Body: getRes.Body,
        ContentType: contentType,
        ContentLength: objectSize > 0 ? objectSize : undefined,
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

  try {
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
  } catch (err) {
    stmts.updateMigration.run({
      migration_id: migrationId,
      status: 'failed',
      completed_at: Date.now(),
      done_objects: done,
      failed_objects: failed + 1,
      rollback_json: null,
    })
    throw err
  }

  stmts.updateMigration.run({
    migration_id: migrationId,
    status: failed > 0 ? 'completed_with_errors' : 'completed',
    completed_at: Date.now(),
    done_objects: done,
    failed_objects: failed,
    rollback_json: null,
  })

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
  const record = stmts.getMigration.get(migrationId)
  if (!record) return { migrationId, status: 'error', error: 'migration_not_found' }

  if (record.type === 'replace_config' && record.rollback_json) {
    let rollbackSnapshot
    try { rollbackSnapshot = JSON.parse(record.rollback_json) } catch { rollbackSnapshot = null }

    if (rollbackSnapshot) {
      upsertAccount(rollbackSnapshot)
      stmts.updateMigration.run({
        migration_id: migrationId,
        status: 'rolled_back',
        completed_at: Date.now(),
        done_objects: record.done_objects,
        failed_objects: record.failed_objects,
        rollback_json: record.rollback_json,
      })
      return {
        migrationId,
        status: 'rolled_back',
        type: 'replace_config',
        message: `Config của account ${record.source_account_id} đã được khôi phục về snapshot cũ.`,
      }
    }
  }

  return {
    migrationId,
    status: 'manual_required',
    type: record.type,
    message: 'Automatic rollback chỉ hỗ trợ replace_config. Với copy_objects, chạy migrate theo chiều ngược lại nếu cần.',
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

export function listMigrationsFromDb({ limit = 20, offset = 0 } = {}) {
  return stmts.listMigrations.all({ limit, offset })
}
