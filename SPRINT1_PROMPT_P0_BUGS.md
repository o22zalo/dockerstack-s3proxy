# AGENT PROMPT — SPRINT 1: Fix Critical Bugs (P0)
# Backup System — BUG-1, BUG-2, BUG-3
# Yêu cầu agent thực hiện theo đúng thứ tự, không được bỏ sót bước nào.

---

## CONTEXT

Dự án: `dockerstack-s3proxy` — Node.js ESM · Fastify · better-sqlite3 · Firebase RTDB
Thư mục làm việc: `services/s3proxy/src/`

Bạn sẽ fix **3 critical bugs (P0)** trong hệ thống backup. Đọc kỹ từng mục trước khi chỉnh code.
Sau khi hoàn thành, bạn BẮT BUỘC viết implementation report theo mẫu ở cuối prompt này.

---

## BUG-1: RAM buffer trong restoreManager.js và backendReplacer.js

### Vấn đề
Cả hai file đang buffer toàn bộ nội dung S3 object vào RAM trước khi upload:

```js
// SÁCH: Pattern hiện tại - SAI
const chunks = []
for await (const chunk of readStream) {
  chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
}
const body = Buffer.concat(chunks) // 512MB file → 512MB RAM spike → OOM crash
await client.send(new PutObjectCommand({ ..., Body: body }))
```

Với BACKUP_MAX_OBJECT_SIZE_MB=512, một object 512MB sẽ crash node.js do heap overflow.

### Fix BUG-1a: `services/s3proxy/src/backup/restoreManager.js`

Tìm hàm `startRestoreJob`. Trong vòng lặp `for (const entry of ledgerEntries)`, đoạn xử lý upload:

**TRƯỚC (xóa toàn bộ đoạn này):**
```js
const readStream = await sourceDest.read(entry.dst_key)
const contentType = 'application/octet-stream'
const sizeBytes = Number(entry.src_size_bytes || 0)

const client = new S3Client({
  endpoint: targetAccount.endpoint,
  region: targetAccount.region || 'us-east-1',
  credentials: {
    accessKeyId: targetAccount.access_key_id,
    secretAccessKey: targetAccount.secret_key,
  },
  forcePathStyle: true,
})

const chunks = []
for await (const chunk of readStream) {
  chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
}
const body = Buffer.concat(chunks)

await client.send(new PutObjectCommand({
  Bucket: targetAccount.bucket,
  Key: entry.backend_key,
  Body: body,
  ContentType: contentType,
}))
```

**SAU (thay bằng):**
```js
const readStream = await sourceDest.read(entry.dst_key)
const contentType = entry.content_type || 'application/octet-stream'
const sizeBytes = Number(entry.src_size_bytes || 0)

const client = new S3Client({
  endpoint: targetAccount.endpoint,
  region: targetAccount.region || 'us-east-1',
  credentials: {
    accessKeyId: targetAccount.access_key_id,
    secretAccessKey: targetAccount.secret_key,
  },
  forcePathStyle: true,
})

// Stream trực tiếp — KHÔNG buffer vào RAM
// S3 SDK cần biết ContentLength để stream đúng cách
await client.send(new PutObjectCommand({
  Bucket: targetAccount.bucket,
  Key: entry.backend_key,
  Body: readStream,
  ContentType: contentType,
  ContentLength: sizeBytes > 0 ? sizeBytes : undefined,
}))
```

**Lưu ý quan trọng:**
- Xóa import `S3Client` constructor khỏi trong vòng lặp — tạo 1 lần bên ngoài vòng lặp và reuse:
  ```js
  // Trước vòng lặp for (const entry of ledgerEntries):
  const clientCache = new Map() // accountId → S3Client
  const getOrCreateClient = (account) => {
    if (clientCache.has(account.account_id)) return clientCache.get(account.account_id)
    const c = new S3Client({
      endpoint: account.endpoint,
      region: account.region || 'us-east-1',
      credentials: { accessKeyId: account.access_key_id, secretAccessKey: account.secret_key },
      forcePathStyle: true,
    })
    clientCache.set(account.account_id, c)
    return c
  }
  ```
  Rồi dùng `const client = getOrCreateClient(targetAccount)` thay vì `new S3Client(...)` trong loop.

### Fix BUG-1b: `services/s3proxy/src/backup/backendReplacer.js`

Tìm hàm `migrateBackendObjects`, hàm nội bộ `migrateOne`. Đoạn copy object:

**TRƯỚC (xóa):**
```js
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
```

**SAU (thay bằng — streaming):**
```js
// HEAD trước để lấy size (cần cho ContentLength khi stream)
const headRes = await sourceClient.send(new HeadObjectCommand({
  Bucket: sourceAccount.bucket,
  Key: route.backend_key,
}))
const objectSize = Number(headRes.ContentLength || 0)
const contentType = headRes.ContentType || 'application/octet-stream'

// GET object — lấy stream, không buffer
const getRes = await sourceClient.send(new GetObjectCommand({
  Bucket: sourceAccount.bucket,
  Key: route.backend_key,
}))

// PUT trực tiếp stream sang target — không qua RAM
await targetClient.send(new PutObjectCommand({
  Bucket: targetAccount.bucket,
  Key: route.backend_key,
  Body: getRes.Body,            // stream trực tiếp
  ContentType: contentType,
  ContentLength: objectSize > 0 ? objectSize : undefined,
}))
```

Thêm `HeadObjectCommand` vào import nếu chưa có:
```js
import {
  S3Client,
  HeadBucketCommand,
  HeadObjectCommand,   // ← thêm
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3'
```

### Verify BUG-1
Sau khi fix, search toàn bộ codebase trong `src/backup/` với pattern `Buffer.concat`:
```bash
grep -rn "Buffer.concat\|chunks.push" services/s3proxy/src/backup/
```
Kết quả chỉ được phép tồn tại trong `destinations/s3Dest.js` (multipart upload) và `destinations/onedriveDest.js` (đây là known issue P3, không fix trong sprint này).
Nếu còn xuất hiện ở `restoreManager.js` hoặc `backendReplacer.js` → chưa fix xong.

---

## BUG-2: backend_migrations bảng không được ghi

### Vấn đề
Hàm `replaceBackendConfig()` và `migrateBackendObjects()` trong `backendReplacer.js` tạo `migrationId` local nhưng **không INSERT vào bảng `backend_migrations`**. Hậu quả:
- `GET /admin/backup/backends/migrations` luôn trả `[]`
- `rollbackMigration(migrationId)` không tìm được data
- Không có audit trail

### Fix BUG-2a: Import db và thêm statements

Ở đầu file `services/s3proxy/src/backup/backendReplacer.js`, thêm import `db`:

```js
import {
  getAccountById,
  upsertAccount,
  getAllAccounts,
  getTrackedRoutesByAccount,
  commitUploadedObjectMetadata,
  db,             // ← thêm import db instance
} from '../db.js'
```

Sau các import, thêm prepared statements:

```js
// Prepared statements cho backend_migrations
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
```

Xác nhận `db` được export từ `db.js`. Nếu chưa, tìm trong `db.js`:
```js
// Trong db.js phải có:
export { db }
// hoặc:
export const db = new Database(...)
```

### Fix BUG-2b: Sửa `replaceBackendConfig()`

Tìm hàm `replaceBackendConfig`. Thêm INSERT vào đầu và UPDATE vào cuối:

```js
export async function replaceBackendConfig(sourceAccountId, newAccountConfig, { dryRun = false } = {}) {
  const migrationId = `mig_${randomUUID()}`
  const existing = getAccountById(sourceAccountId)
  if (!existing) throw new Error(`account not found: ${sourceAccountId}`)

  const rollbackSnapshot = { ...existing }
  const createdAt = Date.now()

  // INSERT migration record ngay khi bắt đầu
  stmts.insertMigration.run({
    migration_id: migrationId,
    type: 'replace_config',
    status: dryRun ? 'dry_run' : 'running',
    source_account_id: sourceAccountId,
    target_account_id: sourceAccountId, // replace_config không đổi account_id
    created_at: createdAt,
    started_at: createdAt,
    total_objects: 0, // replace_config không copy objects
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

  // UPDATE migration record khi hoàn thành, lưu rollback snapshot
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
```

### Fix BUG-2c: Sửa `migrateBackendObjects()`

Tìm hàm `migrateBackendObjects`. Thêm INSERT ở đầu và UPDATE ở cuối:

```js
export async function migrateBackendObjects(sourceAccountId, targetAccountId, options = {}, logger = console) {
  const { dryRun = false, deleteSource = false, skipExistingByEtag = true, concurrency = 3 } = options
  const migrationId = `mig_${randomUUID()}`

  const sourceAccount = getAccountById(sourceAccountId)
  if (!sourceAccount) throw new Error(`source account not found: ${sourceAccountId}`)

  const targetAccount = getAccountById(targetAccountId)
  if (!targetAccount) throw new Error(`target account not found: ${targetAccountId}`)

  const routes = getTrackedRoutesByAccount(sourceAccountId)

  // INSERT migration record
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

  // ... (giữ nguyên phần xử lý routes, sourceClient, targetClient, tasks ...)

  // ĐẦU KẾT: Thay đoạn return cuối hàm bằng:
  stmts.updateMigration.run({
    migration_id: migrationId,
    status: failed > 0 ? 'completed_with_errors' : 'completed',
    completed_at: Date.now(),
    done_objects: done,
    failed_objects: failed,
    rollback_json: null, // copy_objects không hỗ trợ auto rollback
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
```

**Quan trọng:** Wrap toàn bộ logic migrateOne trong try/catch. Nếu hàm throw unhandled error trước khi update, thêm:
```js
try {
  // ... main migration logic ...
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
```

### Fix BUG-2d: Sửa `rollbackMigration()`

```js
export async function rollbackMigration(migrationId) {
  const record = stmts.getMigration.get(migrationId)
  if (!record) return { migrationId, status: 'error', error: 'migration_not_found' }

  // Chỉ hỗ trợ rollback cho replace_config (có rollback_json)
  if (record.type === 'replace_config' && record.rollback_json) {
    let rollbackSnapshot
    try { rollbackSnapshot = JSON.parse(record.rollback_json) } catch { rollbackSnapshot = null }

    if (rollbackSnapshot) {
      upsertAccount(rollbackSnapshot)
      stmts.updateMigration.run({
        migration_id: migrationId,
        status: 'rolled_back',
        completed_at: Date.now(), // không overwrite, dùng field riêng nếu cần
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

  // copy_objects: không auto rollback vì objects đã được copy
  return {
    migrationId,
    status: 'manual_required',
    type: record.type,
    message: 'Automatic rollback chỉ hỗ trợ replace_config. Với copy_objects, chạy migrate theo chiều ngược lại nếu cần.',
  }
}
```

### Fix BUG-2e: Sửa `listMigrations` endpoint trong `routes/backup.js`

Thêm import:
```js
// Trong routes/backup.js, thêm import
import { listMigrationsFromDb } from '../backup/backendReplacer.js'
```

Trong `backendReplacer.js`, thêm export:
```js
export function listMigrationsFromDb({ limit = 20, offset = 0 } = {}) {
  return stmts.listMigrations.all({ limit, offset })
}
```

Sửa endpoint trong `routes/backup.js`:
```js
// TRƯỚC:
fastify.get('/admin/backup/backends/migrations', async () => {
  return { ok: true, migrations: [] }
})

// SAU:
fastify.get('/admin/backup/backends/migrations', async (request) => {
  const limit = Number(request.query.limit || 20)
  const offset = Number(request.query.offset || 0)
  const migrations = listMigrationsFromDb({ limit, offset })
  return { ok: true, migrations }
})
```

### Verify BUG-2
Sau khi fix:
```bash
# Test replace_config
curl -X POST http://localhost:PORT/admin/backup/backends/replace-config \
  -H "x-api-key: KEY" \
  -H "Content-Type: application/json" \
  -d '{"sourceAccountId":"test-acc","newAccountConfig":{"endpoint":"https://new.endpoint"},"dryRun":false}'
# → Response phải có migrationId

# Verify DB
sqlite3 .docker-volumes/s3proxy-data/routes.db "SELECT migration_id, type, status FROM backend_migrations LIMIT 5;"
# → Phải có rows

# Verify list endpoint
curl http://localhost:PORT/admin/backup/backends/migrations -H "x-api-key: KEY"
# → migrations array không còn rỗng sau khi có data
```

---

## BUG-3: ZIP download endpoint broken

### Vấn đề
`GET /admin/backup/jobs/:jobId/download` kiểm tra job.status === 'completed' nhưng không có gì để serve — ZipDestination cần outputStream lúc init, không thể stream lại sau khi đã finalized.

### Giải pháp: ZIP job ghi vào temporary local file, endpoint serve file đó

**Bước 1: Sửa `backupManager.js` — khi tạo zip job, tự động thêm outputPath**

Tìm hàm `startBackupJob`. Thêm logic resolve outputPath cho zip:

```js
export async function startBackupJob(payload) {
  const destinationConfig = payload?.destinationConfig || {}
  const destinationType = payload.destinationType

  // Với zip destination: nếu không có outputPath/outputStream,
  // tự động assign outputPath vào thư mục temp
  if (destinationType === 'zip' && !destinationConfig.outputPath && !destinationConfig.outputStream) {
    const os = await import('os')
    const path = await import('path')
    const tmpDir = process.env.BACKUP_ZIP_TMP_DIR || os.default.tmpdir()
    // outputPath sẽ được gán sau khi có jobId — xử lý trong processBackupJob
    destinationConfig._autoAssignOutputPath = true
    destinationConfig._zipTmpDir = tmpDir
    payload.destinationConfig = destinationConfig
  }

  // ... validation (giữ nguyên)
  if (Array.isArray(destinationConfig.destinations) && destinationConfig.destinations.length > 0) {
    destinationConfig.destinations.forEach((item) => {
      if (item.type !== 'zip') { // zip không init tại đây vì chưa có outputPath
        createDestination(item.type || destinationType, item.config || {})
      }
    })
  } else if (destinationType !== 'zip') {
    createDestination(destinationType, destinationConfig)
  }

  return createBackupJob(payload)
}
```

**Bước 2: Sửa `processBackupJob` trong `backupManager.js` — resolve outputPath trước khi tạo ZipDestination**

Tìm đoạn khởi tạo `destinations` trong `processBackupJob`. Với zip destination, tự assign outputPath:

```js
// Trong processBackupJob, trước đoạn tạo destinations array:
const resolvedDestConfig = { ...destinationConfig }

if (destinationType === 'zip' && resolvedDestConfig._autoAssignOutputPath) {
  const path = await import('path')
  resolvedDestConfig.outputPath = path.default.join(
    resolvedDestConfig._zipTmpDir || '/tmp',
    `backup-${job.job_id}.zip`
  )
  delete resolvedDestConfig._autoAssignOutputPath
  delete resolvedDestConfig._zipTmpDir
  // Cập nhật destination_config trong DB để lưu outputPath
  // (để download endpoint biết path)
  // Dùng db trực tiếp hoặc thêm helper trong journal
}

const destinations = Array.isArray(resolvedDestConfig.destinations) && resolvedDestConfig.destinations.length > 0
  ? resolvedDestConfig.destinations.map((item) => ({
    type: item.type || destinationType,
    adapter: createDestination(item.type || destinationType, item.config || {}),
  }))
  : [{ type: destinationType, adapter: createDestination(destinationType, resolvedDestConfig) }]
```

**Bước 3: Sau khi zip job completed, lưu outputPath vào DB**

Thêm function trong `backupJournal.js`:
```js
// Thêm statement
const updateJobOutputPath = db.prepare(`
  UPDATE backup_jobs SET options_json = json_set(options_json, '$.outputPath', @output_path)
  WHERE job_id = @job_id
`)

export function setJobOutputPath(jobId, outputPath) {
  updateJobOutputPath.run({ job_id: jobId, output_path: outputPath })
}
```

Trong `processBackupJob`, sau khi resolve outputPath, gọi:
```js
import { setJobOutputPath } from './backupJournal.js'
// ...
if (destinationType === 'zip' && resolvedDestConfig.outputPath) {
  setJobOutputPath(job.job_id, resolvedDestConfig.outputPath)
}
```

**Bước 4: Sửa download endpoint trong `routes/backup.js`**

```js
// Thêm import
import { createReadStream, existsSync } from 'fs'
import { pipeline } from 'stream/promises'

fastify.get('/admin/backup/jobs/:jobId/download', async (request, reply) => {
  const job = getJobLiveStatus(request.params.jobId)
  if (!job) return reply.code(404).send({ ok: false, error: 'JOB_NOT_FOUND' })
  if (job.destination_type !== 'zip') {
    return reply.code(400).send({ ok: false, error: 'JOB_NOT_ZIP_TYPE' })
  }
  if (job.status !== 'completed') {
    return reply.code(409).send({ ok: false, error: 'JOB_NOT_COMPLETED', status: job.status })
  }

  // Lấy outputPath từ options_json
  const outputPath = job.options?.outputPath
  if (!outputPath) {
    return reply.code(404).send({ ok: false, error: 'ZIP_OUTPUT_PATH_NOT_SET' })
  }
  if (!existsSync(outputPath)) {
    return reply.code(404).send({ ok: false, error: 'ZIP_FILE_NOT_FOUND', path: outputPath })
  }

  reply.raw.setHeader('Content-Type', 'application/zip')
  reply.raw.setHeader('Content-Disposition', `attachment; filename="backup-${request.params.jobId}.zip"`)
  reply.raw.setHeader('Cache-Control', 'no-store')

  const fileStream = createReadStream(outputPath)
  await pipeline(fileStream, reply.raw)
  return reply
})
```

**Bước 5: Thêm `pipeline` import trong routes/backup.js nếu chưa có**

```js
import { createReadStream, existsSync } from 'fs'
import { pipeline } from 'stream/promises'
```

**Bước 6: ZipDestination cần gọi `finalize()` sau khi job xong**

Trong `processBackupJob`, sau khi `await Promise.all(inFlight)`, trước `updateJobStatus('completed')`:

```js
// Finalize zip destinations nếu có
for (const dest of destinations) {
  if (dest.type === 'zip' && typeof dest.adapter.finalize === 'function') {
    await dest.adapter.finalize()
  }
}
```

### Verify BUG-3
```bash
# 1. Tạo zip backup job với vài objects
curl -X POST http://localhost:PORT/admin/backup/jobs \
  -H "x-api-key: KEY" -H "Content-Type: application/json" \
  -d '{"type":"full","destinationType":"zip","accountFilter":["small-account"],"options":{}}'
# → Ghi lại jobId

# 2. Chờ job completed
curl http://localhost:PORT/admin/backup/jobs/{jobId} -H "x-api-key: KEY"
# → status: "completed"

# 3. Download
curl -o backup.zip http://localhost:PORT/admin/backup/jobs/{jobId}/download -H "x-api-key: KEY"
# → File backup.zip phải tồn tại và có content

# 4. Verify ZIP hợp lệ
unzip -l backup.zip
# → Phải list được danh sách files
```

---

## CLEANUP SAU KHI FIX 3 BUGS

### Chạy lại tests
```bash
cd services/s3proxy
npm test
# Hoặc nếu có test riêng cho backup:
node --experimental-vm-modules node_modules/.bin/jest test/backup-system.test.js
node --experimental-vm-modules node_modules/.bin/jest test/backup-api.test.js
```

Nếu có test failures không liên quan đến thay đổi của bạn → ghi chú vào report nhưng không fix (out of scope).
Nếu test failures do thay đổi của bạn gây ra → phải fix.

### Lint check
```bash
cd services/s3proxy
npm run lint 2>/dev/null || echo "no lint configured"
```

---

## BÁO CÁO BẮT BUỘC (Viết sau khi hoàn thành)

Bạn PHẢI tạo file `docs/SPRINT1_IMPLEMENTATION_REPORT.md` với đầy đủ các mục sau. Không được bỏ sót bất kỳ mục nào. Nếu một hạng mục không làm được, phải ghi rõ lý do.

```markdown
# Sprint 1 Implementation Report — P0 Bug Fixes
> Ngày: YYYY-MM-DD | Agent: [tên/version]

## Tóm tắt
[2-3 câu mô tả tổng quan những gì đã làm]

## BUG-1: RAM buffer → Streaming

### restoreManager.js
- [ ] Đã xóa pattern `chunks.push` + `Buffer.concat`
- [ ] Đã thay bằng streaming `Body: readStream`
- [ ] Đã thêm `ContentLength` khi có sizeBytes
- [ ] Đã tạo `clientCache` để reuse S3Client
- Diff ngắn gọn (5-10 dòng quan trọng nhất):
  ```diff
  [paste diff ở đây]
  ```

### backendReplacer.js
- [ ] Đã thêm `HeadObjectCommand` để lấy size trước khi stream
- [ ] Đã xóa pattern `chunks.push` + `Buffer.concat`
- [ ] Đã thay bằng streaming `Body: getRes.Body`
- Diff ngắn gọn:
  ```diff
  [paste diff ở đây]
  ```

### Verify result
- grep `Buffer.concat` trong backup/ còn không: [kết quả]
- Remaining occurrences (nếu có): [file:line - lý do OK]

## BUG-2: backend_migrations không ghi DB

### Các thay đổi
- [ ] Đã import `db` từ `../db.js` trong backendReplacer.js
- [ ] Đã thêm `stmts` object với 4 prepared statements
- [ ] `replaceBackendConfig()` INSERT + UPDATE backend_migrations
- [ ] `migrateBackendObjects()` INSERT + UPDATE backend_migrations
- [ ] `rollbackMigration()` thực sự đọc DB và rollback replace_config
- [ ] Export `listMigrationsFromDb()` từ backendReplacer.js
- [ ] routes/backup.js sử dụng `listMigrationsFromDb()` thay vì hardcoded `[]`

### Verify result
- `GET /admin/backup/backends/migrations` sau khi chạy 1 migration: [kết quả JSON]
- DB query: `SELECT * FROM backend_migrations LIMIT 3;` [kết quả]

## BUG-3: ZIP download endpoint

### Các thay đổi
- [ ] `startBackupJob()` detect zip + set `_autoAssignOutputPath`
- [ ] `processBackupJob()` resolve outputPath trước khi tạo ZipDestination
- [ ] `setJobOutputPath()` thêm vào backupJournal.js
- [ ] outputPath được lưu vào `options_json` trong DB
- [ ] ZipDestination `finalize()` được gọi sau khi job xong
- [ ] Download endpoint đọc outputPath từ options_json và stream file
- [ ] Import `createReadStream`, `existsSync`, `pipeline` đã có trong routes/backup.js

### Verify result
- ZIP job created với jobId: [jobId]
- outputPath trong DB: [path]
- File tồn tại trên disk: [yes/no]
- `unzip -l backup.zip` output: [vài dòng đầu]

## Test results
- Total tests: [số]
- Passed: [số]
- Failed: [số]
- Failures do thay đổi của sprint này: [có/không, nếu có list ra]

## So sánh với prompt gốc (Sprint 1)
| Hạng mục trong prompt | Đã làm | Ghi chú |
|---|---|---|
| BUG-1a: restoreManager stream | ✅/❌ | |
| BUG-1b: backendReplacer stream | ✅/❌ | |
| BUG-1 verify grep | ✅/❌ | |
| BUG-2a: import db | ✅/❌ | |
| BUG-2b: replaceBackendConfig INSERT/UPDATE | ✅/❌ | |
| BUG-2c: migrateBackendObjects INSERT/UPDATE | ✅/❌ | |
| BUG-2d: rollbackMigration đọc DB | ✅/❌ | |
| BUG-2e: listMigrations endpoint | ✅/❌ | |
| BUG-3: auto outputPath cho zip | ✅/❌ | |
| BUG-3: setJobOutputPath journal | ✅/❌ | |
| BUG-3: finalize() sau job xong | ✅/❌ | |
| BUG-3: download endpoint stream file | ✅/❌ | |
| Cleanup: npm test | ✅/❌ | |

## Vấn đề gặp phải và cách xử lý
[Liệt kê bất kỳ khó khăn, edge case, hoặc deviation so với plan và lý do]

## Thay đổi không có trong prompt (nếu có)
[Liệt kê bất kỳ thay đổi ngoài scope của prompt, lý do cần thiết]
```

---

**NHẮC NHỞ CUỐI:** Đọc lại toàn bộ prompt này một lần nữa trước khi submit report. Đối chiếu từng checkbox trong bảng "So sánh với prompt gốc" — nếu có ô ❌ mà không có giải thích → bạn chưa hoàn thành task.
