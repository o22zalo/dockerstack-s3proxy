# Kế hoạch triển khai: Hệ thống Backup / Restore / Backend Replacement

> Phiên bản: 1.0 | Dành cho agent thực hiện
> Stack: Node.js ESM · Fastify · better-sqlite3 · Firebase RTDB REST · undici

---

## 0. Tổng quan kiến trúc

```
[Admin UI - backup tab]
        │
        ▼
[routes/backup.js]  ←→  [backupManager.js]  ←→  [backupJournal.js]
                                │                       │
                         [backupWorker.js]       [Backup RTDB]  (DB riêng, không ảnh hưởng production)
                                │
                    [backupDestinations.js]
                    ┌─────┬──────┬──────┬────────┐
                   S3   GDrive OneDrive  ZIP   LocalFS
```

**Nguyên tắc thiết kế:**
- Backup chạy trong background worker, không block request path.
- Mỗi object trong S3 được theo dõi riêng lẻ trong journal → có thể resume sau khi gián đoạn.
- Một RTDB riêng (BACKUP_RTDB_URL) lưu toàn bộ state backup/restore — không chạm vào production RTDB.
- Rate-limit và concurrency control để không ảnh hưởng tới performance app.

---

## 1. Biến môi trường mới

Thêm vào `.env.example` và `src/config.js`:

```env
# Backup system — separate Firebase RTDB (KHÔNG dùng chung với FIREBASE_RTDB_URL)
BACKUP_RTDB_URL=https://your-backup-project-default-rtdb.firebasedatabase.app/backup.json?auth=secret_xxxxx

# Concurrency control
BACKUP_CONCURRENCY=3              # Số object stream song song tối đa (default: 3)
BACKUP_CHUNK_STREAM_MS=50         # Delay giữa mỗi object để throttle (ms, default: 50)
BACKUP_MAX_OBJECT_SIZE_MB=512     # Bỏ qua object lớn hơn mức này (default: 512)
BACKUP_ENABLED=true               # Bật/tắt toàn bộ backup system
```

---

## 2. SQLite — Các bảng mới

File: `services/s3proxy/src/db.js` — thêm vào phần `db.exec(...)` khởi tạo.

### 2.1 Bảng `backup_jobs`

```sql
CREATE TABLE IF NOT EXISTS backup_jobs (
  job_id          TEXT PRIMARY KEY,
  type            TEXT NOT NULL DEFAULT 'full',
  -- type: 'full' | 'account' | 'restore' | 'migrate_backend'
  status          TEXT NOT NULL DEFAULT 'pending',
  -- status: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
  created_at      INTEGER NOT NULL,
  started_at      INTEGER,
  completed_at    INTEGER,
  destination_type TEXT NOT NULL,
  -- destination_type: 's3' | 'gdrive' | 'onedrive' | 'zip' | 'local'
  destination_config_json TEXT NOT NULL DEFAULT '{}',
  -- JSON: {bucket, endpoint, accessKeyId, secretKey} for S3; {token, folderId} for GDrive, etc.
  account_filter_json TEXT NOT NULL DEFAULT '[]',
  -- [] = all accounts; ['acc1','acc2'] = specific accounts
  total_objects   INTEGER NOT NULL DEFAULT 0,
  done_objects    INTEGER NOT NULL DEFAULT 0,
  failed_objects  INTEGER NOT NULL DEFAULT 0,
  total_bytes     INTEGER NOT NULL DEFAULT 0,
  done_bytes      INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  resume_token    TEXT,
  -- Encoded state để resume: {accountId, continuationToken, objectKey}
  options_json    TEXT NOT NULL DEFAULT '{}'
  -- {includeRtdb: true, skipExistingByEtag: true, dryRun: false}
);
```

### 2.2 Bảng `backup_ledger`

```sql
CREATE TABLE IF NOT EXISTS backup_ledger (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id          TEXT NOT NULL REFERENCES backup_jobs(job_id),
  account_id      TEXT NOT NULL,
  backend_bucket  TEXT NOT NULL,
  backend_key     TEXT NOT NULL,
  encoded_key     TEXT NOT NULL,
  -- encoded_key của route tương ứng (để map lại metadata)
  status          TEXT NOT NULL DEFAULT 'pending',
  -- status: 'pending' | 'done' | 'failed' | 'skipped'
  src_etag        TEXT,
  src_size_bytes  INTEGER,
  dst_key         TEXT,
  -- Key trong destination (ví dụ: backup/2026-04-21/account-id/bucket/object-key)
  dst_location    TEXT,
  -- URL hoặc path đầy đủ trong destination
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  error           TEXT,
  completed_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_backup_ledger_job_status ON backup_ledger(job_id, status);
CREATE INDEX IF NOT EXISTS idx_backup_ledger_account ON backup_ledger(job_id, account_id);
CREATE INDEX IF NOT EXISTS idx_backup_ledger_key ON backup_ledger(job_id, backend_key);
```

### 2.3 Bảng `backend_migrations`

```sql
CREATE TABLE IF NOT EXISTS backend_migrations (
  migration_id    TEXT PRIMARY KEY,
  type            TEXT NOT NULL,
  -- type: 'replace_config' | 'copy_objects' | 'repoint_routes'
  status          TEXT NOT NULL DEFAULT 'pending',
  source_account_id TEXT NOT NULL,
  target_account_id TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  started_at      INTEGER,
  completed_at    INTEGER,
  total_objects   INTEGER NOT NULL DEFAULT 0,
  done_objects    INTEGER NOT NULL DEFAULT 0,
  failed_objects  INTEGER NOT NULL DEFAULT 0,
  rollback_json   TEXT,
  -- Snapshot config cũ để rollback
  options_json    TEXT NOT NULL DEFAULT '{}'
  -- {deleteSource: false, dryRun: false, skipExistingByEtag: true}
);
```

### 2.4 Bảng `backend_migration_ledger`

```sql
CREATE TABLE IF NOT EXISTS backend_migration_ledger (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  migration_id    TEXT NOT NULL REFERENCES backend_migrations(migration_id),
  encoded_key     TEXT NOT NULL,
  object_key      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  src_etag        TEXT,
  dst_etag        TEXT,
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  completed_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_mig_ledger_status ON backend_migration_ledger(migration_id, status);
```

---

## 3. Cấu trúc Firebase RTDB (backup riêng)

URL format: `https://xxx.firebasedatabase.app/backup.json?auth=<secret>`

```
/backup/
  jobs/
    {job_id}/
      status: "running"
      type: "full"
      createdAt: 1714000000000
      startedAt: 1714000100000
      completedAt: null
      destinationType: "s3"
      progress/
        totalObjects: 5000
        doneObjects: 1200
        failedObjects: 3
        totalBytes: 10737418240
        doneBytes: 2684354560
        percentDone: 24.0
        currentAccountId: "acc01"
        currentKey: "photos/img.jpg"
      accounts/
        {account_id}/
          status: "running"
          totalObjects: 800
          doneObjects: 450
          failedObjects: 1
  migrations/
    {migration_id}/
      status: "running"
      sourceAccountId: "acc01"
      targetAccountId: "acc02"
      progress/...
```

---

## 4. Cấu trúc file mới

```
services/s3proxy/src/
  backup/
    backupManager.js       ← Điều phối chính: tạo job, queue, stop/pause
    backupJournal.js       ← Đọc/ghi state job vào SQLite + RTDB backup
    backupWorker.js        ← Stream từng object S3 → destination
    restoreManager.js      ← Đọc backup → restore S3 + rebuild metadata
    backendReplacer.js     ← Swap config + migrate objects giữa accounts
    destinations/
      index.js             ← Factory: tạo đúng adapter theo type
      s3Dest.js            ← Upload lên S3-compatible endpoint
      gdriveDest.js        ← Upload qua Google Drive REST API (resumable)
      onedriveDest.js      ← Upload qua Microsoft Graph API
      zipDest.js           ← Stream ra ZIP (pipe thẳng vào HTTP response)
      localDest.js         ← Write vào local filesystem (volume mount)
  routes/
    backup.js              ← Toàn bộ HTTP endpoints backup/restore/migration
```

---

## 5. Chi tiết từng file

---

### 5.1 `backup/backupJournal.js`

**Trách nhiệm:** Là single source of truth về trạng thái job. Tất cả write đều phải qua đây.

**Export functions:**

```js
// Tạo job mới trong SQLite + ghi lên RTDB backup
export async function createBackupJob({ type, destinationType, destinationConfig, accountFilter, options })
// returns: jobRow

// Cập nhật status job (running/paused/completed/failed)
export async function updateJobStatus(jobId, status, extras = {})
// extras: { lastError, completedAt, resumeToken }

// Ghi progress tổng hợp sau mỗi batch
export async function updateJobProgress(jobId, { totalObjects, doneObjects, failedObjects, totalBytes, doneBytes, currentAccountId, currentKey })

// Upsert một ledger entry (tạo nếu chưa có, update nếu có)
export function upsertLedgerEntry({ jobId, accountId, backendBucket, backendKey, encodedKey, status, srcEtag, srcSizeBytes })

// Cập nhật ledger entry sau khi copy xong hoặc fail
export function markLedgerDone({ jobId, backendKey, dstKey, dstLocation, completedAt })
export function markLedgerFailed({ jobId, backendKey, error, attemptCount })

// Đọc lại ledger để resume: trả về các entry status='pending' hoặc 'failed' (attempt < MAX)
export function getPendingLedgerEntries(jobId, { limit = 100, afterId = 0 })

// Kiểm tra object đã backup xưa rồi hay chưa (để skip nếu skipExistingByEtag=true)
export function findLedgerByEtag(jobId, accountId, backendKey, etag)

// Lấy job hiện tại đang chạy
export function getRunningJob()

// Lấy job theo id
export function getJobById(jobId)

// Danh sách jobs (phân trang)
export function listJobs({ limit = 20, offset = 0, status })

// Sync progress lên RTDB backup (throttle: không gọi quá 1 lần/2s)
export async function syncProgressToRtdb(jobId, progressSnapshot)

// Xóa job cũ (cleanup)
export function deleteJobById(jobId)
```

**Nội bộ:**

```js
// Debounce sync RTDB: chỉ flush mỗi 2 giây
const rtdbSyncTimers = new Map()  // jobId → timer

// buildRtdbPath(jobId) → '/backup/jobs/{jobId}'
// backupRtdbGet(path)  → fetch với BACKUP_RTDB_URL
// backupRtdbPatch(path, data) → PATCH
```

---

### 5.2 `backup/backupManager.js`

**Trách nhiệm:** Orchestrate toàn bộ vòng đời backup. Expose start/stop/pause/resume. Manage concurrency.

**State nội bộ:**

```js
const activeJobs = new Map()  // jobId → { abortController, status, timer }
let globalQueue = []          // array of pending jobIds (chạy lần lượt hoặc có thể parallel)
```

**Export functions:**

```js
// Khởi tạo scheduler (gọi 1 lần khi app start)
export function initBackupManager(logger)

// Tạo và start backup job
export async function startBackupJob({ type, destinationType, destinationConfig, accountFilter, options }, logger)
// 1. createBackupJob() trong journal
// 2. Tạo AbortController
// 3. Chạy runBackupJob() trong background (không await)
// 4. Return jobId ngay lập tức

// Stop job đang chạy (graceful: đợi current object xong)
export async function stopBackupJob(jobId)
// Set abortController.abort() → backupWorker sẽ check và dừng

// Pause job (lưu resumeToken vào journal)
export async function pauseBackupJob(jobId)

// Resume job từ resumeToken đã lưu
export async function resumeBackupJob(jobId, logger)

// Lấy live status của 1 job (merge từ SQLite + in-memory)
export function getJobLiveStatus(jobId)

// Main runner (KHÔNG export - chạy internal)
async function runBackupJob(jobId, abortController, logger) {
  // 1. updateJobStatus(jobId, 'running')
  // 2. Load accounts theo accountFilter
  // 3. Với mỗi account:
  //    a. Gọi scanAccountInventory() với onObject callback
  //    b. Mỗi batch MAX_CONCURRENT_OBJECTS → chạy backupWorker song song
  //    c. Sau mỗi object: upsertLedgerEntry, updateJobProgress
  //    d. Check abortController.signal.aborted sau mỗi object
  //    e. Lưu resumeToken = {accountId, continuationToken, lastKey}
  // 4. Nếu options.includeRtdb: dump /routes và /accounts từ production RTDB → destination
  // 5. updateJobStatus('completed')
}
```

**Concurrency pattern (quan trọng):**

```js
// Dùng p-limit hoặc tự implement semaphore
const semaphore = {
  count: 0,
  max: config.BACKUP_CONCURRENCY,
  async acquire() {
    while (this.count >= this.max) {
      await new Promise(r => setTimeout(r, 50))
    }
    this.count++
  },
  release() { this.count-- }
}

// Trong vòng lặp object:
for (const object of objectBatch) {
  if (signal.aborted) break
  await semaphore.acquire()
  backupOneObject(object, ...).finally(() => semaphore.release())
  await sleep(config.BACKUP_CHUNK_STREAM_MS)  // throttle
}
```

---

### 5.3 `backup/backupWorker.js`

**Trách nhiệm:** Copy 1 object từ S3 backend → destination. Idempotent, có retry.

**Export functions:**

```js
// Main copy function
export async function copyObjectToDestination({
  account,        // account row từ SQLite
  backendKey,     // key trong S3 backend
  encodedKey,     // logical key trong s3proxy
  jobId,
  destination,    // destination adapter instance
  options,        // {skipExistingByEtag, dryRun}
  signal,         // AbortSignal
  logger
})
// returns: { status: 'done'|'skipped'|'failed', dstKey, dstLocation, etag, sizeBytes, error }

// Logic bên trong copyObjectToDestination:
// 1. Kiểm tra skipExistingByEtag: findLedgerByEtag() → nếu đã có → return 'skipped'
// 2. Gọi proxyRequest HEAD để lấy etag + size
// 3. Gọi proxyRequest GET → lấy readable stream
// 4. destination.upload({ stream, key, contentType, size, etag })
// 5. Nếu upload thành công: markLedgerDone()
// 6. Retry tối đa 3 lần với exponential backoff nếu lỗi network
// 7. Nếu hết retry: markLedgerFailed()
```

**Key naming convention trong destination:**

```
Format: backup/{jobId}/{YYYY-MM-DD}/{accountId}/{backendBucket}/{backendKey}
Ví dụ: backup/job_abc123/2026-04-21/acc01/supabase-bucket-01/photos/image.jpg
```

**Lưu ý stream:**

```js
// Dùng undici pipeline, không buffer toàn bộ vào RAM
// Với file lớn: chunk theo BACKUP_CHUNK_STREAM_MS
// Abort signal phải được pass vào undici request để cancel mid-stream
```

---

### 5.4 `backup/destinations/index.js`

**Factory function:**

```js
export function createDestination(type, config) {
  switch (type) {
    case 's3':       return new S3Destination(config)
    case 'gdrive':   return new GDriveDestination(config)
    case 'onedrive': return new OneDriveDestination(config)
    case 'zip':      return new ZipDestination(config)
    case 'local':    return new LocalDestination(config)
    default: throw new Error(`Unknown destination type: ${type}`)
  }
}

// Interface mỗi Destination phải implement:
// async upload({ stream, key, contentType, size, etag, signal }) → { location, etag }
// async read(key) → ReadableStream  (dùng cho restore)
// async exists(key) → boolean
// async listKeys(prefix) → AsyncIterable<{key, etag, size}>
// async delete(key)
// async getMetadata(key) → {etag, size, contentType}
```

---

### 5.5 `backup/destinations/s3Dest.js`

```js
export class S3Destination {
  constructor({ endpoint, accessKeyId, secretKey, bucket, region, prefix = '' })
  // Dùng @aws-sdk/client-s3 hoặc undici với SigV4 (tái dùng resignRequest từ sigv4.js)

  async upload({ stream, key, contentType, size, etag, signal }) {
    const destKey = this.prefix + key
    // Nếu size > 5MB: dùng multipart upload
    // Nếu size <= 5MB: dùng PutObject
    // Return { location: `s3://${bucket}/${destKey}`, etag }
  }

  async read(key) {
    // GetObject → trả về Node.js ReadableStream
  }

  async listKeys(prefix) {
    // ListObjectsV2 với pagination → yield {key, etag, size}
  }
}
```

---

### 5.6 `backup/destinations/gdriveDest.js`

```js
// Config: { accessToken, folderId, tokenRefreshUrl? }
// Dùng Google Drive API v3 — resumable upload endpoint
// https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable

export class GDriveDestination {
  constructor({ accessToken, folderId, prefix = '' })

  async upload({ stream, key, contentType, size, signal }) {
    // 1. POST /drive/v3/files?uploadType=resumable để lấy upload URL
    // 2. PUT upload URL với stream body
    // 3. Nếu bị gián đoạn: resume từ Content-Range
    // 4. Return { location: `gdrive://{folderId}/{fileId}`, etag: fileId }
  }

  async read(key) {
    // GET /drive/v3/files/{fileId}?alt=media
  }

  // Lưu ý: GDrive không có native list theo prefix → cần lưu index
  // Index lưu trong SQLite backup_ledger.dst_location
}
```

---

### 5.7 `backup/destinations/onedriveDest.js`

```js
// Config: { accessToken, driveId?, folderId }
// Dùng Microsoft Graph API
// https://graph.microsoft.com/v1.0/me/drive/items/{folderId}:/{filename}:/createUploadSession

export class OneDriveDestination {
  constructor({ accessToken, folderId, prefix = '' })

  async upload({ stream, key, contentType, size, signal }) {
    // 1. POST createUploadSession → lấy uploadUrl
    // 2. PUT uploadUrl với chunks (OneDrive yêu cầu chia chunk tối đa 60MB)
    // 3. Return { location: `onedrive://{driveId}/{itemId}`, etag }
  }
}
```

---

### 5.8 `backup/destinations/zipDest.js`

**Dùng cho ZIP download streaming:**

```js
import { createGzip } from 'zlib'
// Dùng archiver hoặc zip-stream npm package (cần thêm dependency)
// Hoặc implement zip stream thủ công với ZIP central directory

export class ZipDestination {
  constructor({ outputStream })
  // outputStream = Node.js Writable (HTTP response stream)

  async upload({ stream, key, contentType }) {
    // Append entry vào zip archive
    // Không buffer toàn bộ — pipe thẳng vào outputStream
  }

  async finalize() {
    // Đóng zip central directory
  }
}
```

---

### 5.9 `backup/restoreManager.js`

**Trách nhiệm:** Đọc một backup (từ destination) → re-upload vào S3 backends → rebuild metadata SQLite + RTDB.

**Export functions:**

```js
export async function startRestoreJob({
  sourceJobId,           // jobId của backup cần restore
  sourceDestination,     // adapter để đọc backup (s3, gdrive, etc.)
  targetAccountMapping,  // { 'original_acc_id': 'new_acc_id' } — nếu restore sang account khác
  options,               // { dryRun, skipExistingByEtag, rebuildRtdb }
  logger
})

// Luồng restore:
// 1. Đọc backup_ledger từ SQLite (hoặc RTDB nếu SQLite mất)
// 2. Với mỗi ledger entry status='done':
//    a. Resolve targetAccount từ targetAccountMapping
//    b. Đọc object từ sourceDestination.read(entry.dst_key)
//    c. Upload lên S3 backend mới qua proxyRequest
//    d. Gọi commitUploadedObjectMetadata() để rebuild SQLite
//    e. Gọi syncRouteToRtdb() để sync lên production RTDB
// 3. Nếu options.rebuildRtdb: patch toàn bộ accounts lên RTDB

export async function verifyRestoreIntegrity(jobId, sourceDestination)
// So sánh etag trong ledger với etag thực tế trong destination → báo cáo sai lệch
```

---

### 5.10 `backup/backendReplacer.js`

**Trách nhiệm:** Xử lý khi một S3 backend bị lỗi — replace config hoặc migrate objects sang backend khác.

**Export functions:**

```js
// Kiểm tra health của một backend
export async function checkBackendHealth(account)
// Gọi HEAD bucket + list 1 object → return { ok, latencyMs, error }

// Chỉ thay config (không copy object)
// Dùng khi backend mới đã có data (ví dụ: đổi credentials, đổi region)
export async function replaceBackendConfig(sourceAccountId, newAccountConfig, { dryRun = false } = {})
// 1. Lưu config cũ vào backend_migrations (rollback)
// 2. upsertAccount() với config mới
// 3. reloadAccountsFromSQLite()
// 4. Sync lên production RTDB
// 5. Cập nhật tất cả routes có account_id = sourceAccountId → vẫn dùng account_id cũ
//    (routes không đổi, chỉ account config thay đổi)

// Copy toàn bộ objects từ source sang target account
export async function migrateBackendObjects(sourceAccountId, targetAccountId, options = {}, logger)
// options: { dryRun, deleteSource, skipExistingByEtag, concurrency }
// Luồng:
// 1. Tạo migration record trong backend_migrations
// 2. getTrackedRoutesByAccount(sourceAccountId)
// 3. Với mỗi route:
//    a. proxyRequest GET từ source
//    b. proxyRequest PUT lên target (dùng target account credentials)
//    c. commitUploadedObjectMetadata với account_id = targetAccountId
//    d. markLedgerEntry migration done
//    e. Nếu deleteSource: proxyRequest DELETE từ source
// 4. Sau khi migrate xong: deactivate sourceAccount nếu options.deactivateSource

// Rollback một migration
export async function rollbackMigration(migrationId)
// 1. Đọc rollback_json từ backend_migrations
// 2. Restore config gốc qua upsertAccount()
// 3. Nếu objects đã bị copy: chạy ngược lại (copy target → source)
//    → Chỉ cho phép rollback nếu deleteSource=false

// Tự động phát hiện backend lỗi và suggest action
export async function diagnoseBackend(accountId)
// Return:
// {
//   accountId,
//   healthy: false,
//   error: 'Connection timeout',
//   trackedObjects: 1500,
//   trackedBytes: 10_737_418_240,
//   suggestedActions: ['replaceConfig', 'migrateToOtherAccount'],
//   alternativeAccounts: [{ accountId: 'acc02', freeCapacity: 8_589_934_592 }]
// }
```

---

### 5.11 `routes/backup.js`

**Toàn bộ HTTP endpoints.** Mount tại Fastify với prefix `/admin/api/backup`.

```
POST   /admin/api/backup/jobs                → tạo backup job
GET    /admin/api/backup/jobs                → list jobs
GET    /admin/api/backup/jobs/:jobId         → status job
POST   /admin/api/backup/jobs/:jobId/stop    → stop
POST   /admin/api/backup/jobs/:jobId/pause   → pause
POST   /admin/api/backup/jobs/:jobId/resume  → resume
DELETE /admin/api/backup/jobs/:jobId         → xóa record
GET    /admin/api/backup/jobs/:jobId/ledger  → download ledger (phân trang)
GET    /admin/api/backup/jobs/:jobId/download → ZIP stream (chỉ cho type zip)

POST   /admin/api/backup/restore             → tạo restore job
GET    /admin/api/backup/restore/:jobId/status

GET    /admin/api/backup/backends/:accountId/health   → check health
POST   /admin/api/backup/backends/:accountId/diagnose → full diagnose
POST   /admin/api/backup/backends/replace-config      → thay config không copy
POST   /admin/api/backup/backends/migrate             → copy objects sang backend khác
GET    /admin/api/backup/backends/migrations           → list migrations
POST   /admin/api/backup/backends/migrations/:id/rollback → rollback

GET    /admin/api/backup/config              → lấy cấu hình backup hiện tại (BACKUP_RTDB_URL có hay không)
POST   /admin/api/backup/config/test         → test connection BACKUP_RTDB_URL
```

**Security:** Tất cả endpoints dùng `preHandler: [fastify.authenticate]` (x-api-key).

**Request body ví dụ cho tạo backup job:**

```json
{
  "type": "full",
  "destinationType": "s3",
  "destinationConfig": {
    "endpoint": "https://backup-project.supabase.co/storage/v1/s3",
    "accessKeyId": "backup-key-id",
    "secretKey": "backup-secret",
    "bucket": "s3proxy-backups",
    "region": "us-east-1",
    "prefix": "daily/"
  },
  "accountFilter": [],
  "options": {
    "includeRtdb": true,
    "skipExistingByEtag": true,
    "dryRun": false
  }
}
```

**Server-Sent Events cho live progress (optional enhancement):**

```
GET /admin/api/backup/jobs/:jobId/events → EventSource stream
```

```js
reply.raw.setHeader('Content-Type', 'text/event-stream')
reply.raw.setHeader('Cache-Control', 'no-cache')

const interval = setInterval(() => {
  const status = getJobLiveStatus(jobId)
  reply.raw.write(`data: ${JSON.stringify(status)}\n\n`)
  if (['completed','failed','cancelled'].includes(status.status)) {
    clearInterval(interval)
    reply.raw.end()
  }
}, 1000)

request.raw.on('close', () => clearInterval(interval))
```

---

## 6. Admin UI — Tab "Backup & Restore"

File: `services/s3proxy/src/admin-ui.html`

### 6.1 Tab mới thêm vào `.tabs` section

```html
<button class="tab-btn" data-tab="backup">Backup & Restore</button>
```

### 6.2 Nội dung tab `tab-backup` — 4 sub-section

**Section 1: Tạo backup job**

- Form fields:
  - `destinationType`: select (S3 / Google Drive / OneDrive / ZIP download / Local path)
  - Dynamic config fields theo destinationType:
    - S3: endpoint, accessKeyId, secretKey, bucket, region, prefix
    - GDrive: accessToken, folderId
    - OneDrive: accessToken, folderId
    - ZIP: không cần config — download ngay
    - Local: mountPath
  - `accountFilter`: multi-select các account (để trống = all)
  - Checkboxes: includeRtdb, skipExistingByEtag, dryRun
- Nút "Start backup"

**Section 2: Danh sách backup jobs**

- Table: jobId | type | status | dest | progress bar | created | actions
- Actions: Stop / Pause / Resume / View ledger / Download (nếu ZIP) / Delete
- Progress bar: `done_objects / total_objects` + bytes
- Auto-refresh mỗi 3s nếu có job đang running

```js
// Progress bar HTML
`<progress value="${job.doneObjects}" max="${job.totalObjects}"></progress>
 ${job.doneObjects}/${job.totalObjects} objects · ${fmtBytes(job.doneBytes)}/${fmtBytes(job.totalBytes)}
 (${job.percentDone}%)`
```

**Section 3: Backend health & replacement**

- Table accounts + health indicator (auto-check khi load tab)
- Với mỗi account: nút "Check health", "Diagnose", "Replace config", "Migrate objects"
- Form replace config: load form account hiện tại, cho sửa endpoint/credentials
- Form migrate: chọn source account + target account + options
- Hiển thị kết quả diagnose rõ ràng: trackedObjects, suggestedActions

**Section 4: Restore**

- Select: jobId của backup muốn restore
- Account mapping: grid source_accountId → target_accountId
- Options: dryRun, rebuildRtdb
- Log restore realtime (poll mỗi 2s)

### 6.3 Log panel trong tab backup

```html
<pre id="backupLog" style="max-height: 300px; overflow-y: auto;">(chưa có activity)</pre>
```

Mọi API call đều append log vào đây với timestamp.

---

## 7. Sửa `src/index.js`

```js
import backupRoutes from './routes/backup.js'
import { initBackupManager } from './backup/backupManager.js'

// Trong bootstrap():
await fastify.register(backupRoutes)

// Sau khi start listening:
initBackupManager(log)
```

---

## 8. Sửa `src/config.js`

Thêm các config mới vào cuối `config` object:

```js
BACKUP_RTDB_URL: optionalEnv('BACKUP_RTDB_URL', ''),
BACKUP_CONCURRENCY: optionalInt('BACKUP_CONCURRENCY', 3),
BACKUP_CHUNK_STREAM_MS: optionalInt('BACKUP_CHUNK_STREAM_MS', 50),
BACKUP_MAX_OBJECT_SIZE_MB: optionalInt('BACKUP_MAX_OBJECT_SIZE_MB', 512),
BACKUP_ENABLED: optionalBool('BACKUP_ENABLED', true),
```

---

## 9. Sửa `docker-compose/scripts/validate-env.js`

Thêm validation optional cho `BACKUP_RTDB_URL`:

```js
checkOptional('BACKUP_RTDB_URL', 'separate Firebase RTDB for backup metadata', (v) => {
  try {
    const u = new URL(v)
    if (u.protocol !== 'https:') return 'must use https'
    if (!u.pathname.endsWith('.json')) return 'must end with .json'
    if (!u.search.includes('auth=')) return 'must include ?auth= parameter'
    return null
  } catch { return 'must be valid URL' }
})
checkOptional('BACKUP_CONCURRENCY', 'max parallel backup streams', (v) => {
  const n = Number(v)
  return Number.isFinite(n) && n >= 1 && n <= 20 ? null : 'must be 1..20'
})
```

---

## 10. Dependencies mới cần thêm vào `services/s3proxy/package.json`

```json
{
  "dependencies": {
    "archiver": "^7",
    "p-limit": "^6"
  }
}
```

Lưu ý: `p-limit` là ESM-only từ v4+. Import:
```js
import pLimit from 'p-limit'
const limit = pLimit(config.BACKUP_CONCURRENCY)
```

---

## 11. Cấu trúc RTDB backup (đọc/ghi)

File `backup/backupJournal.js` tự implement hàm gọi RTDB backup:

```js
const BACKUP_RTDB_BASE = config.BACKUP_RTDB_URL
  ? new URL(config.BACKUP_RTDB_URL)
  : null

function backupRtdbUrl(subPath) {
  if (!BACKUP_RTDB_BASE) return null
  const base = BACKUP_RTDB_BASE.pathname.replace(/\.json$/, '')
  const auth = BACKUP_RTDB_BASE.searchParams.get('auth')
  const host = BACKUP_RTDB_BASE.origin
  return `${host}${base}/${subPath}.json?auth=${auth}`
}

async function backupRtdbPatch(subPath, data) {
  const url = backupRtdbUrl(subPath)
  if (!url) return
  await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  })
}

async function backupRtdbGet(subPath) {
  const url = backupRtdbUrl(subPath)
  if (!url) return null
  const res = await fetch(url)
  if (!res.ok) return null
  return res.json()
}
```

---

## 12. Luồng backup đầy đủ (step-by-step)

```
User POST /admin/api/backup/jobs
  → backupManager.startBackupJob()
    → backupJournal.createBackupJob()        [SQLite + RTDB backup]
    → Spawn background async runBackupJob()
    → Return { jobId } ngay lập tức

runBackupJob(jobId):
  → backupJournal.updateJobStatus('running')
  → Khởi tạo destination adapter
  → Load danh sách accounts (theo accountFilter)
  → Với mỗi account:
      → scanAccountInventory(account, { onObject, onPage })
          onObject(record):
            → Check abortSignal
            → Check skipExistingByEtag nếu đã backup
            → await semaphore.acquire()
            → backupWorker.copyObjectToDestination(...)
              → GET object từ S3 (undici stream)
              → destination.upload(stream, ...)
              → Nếu ok: backupJournal.markLedgerDone()
              → Nếu fail: backupJournal.markLedgerFailed()
            → semaphore.release()
            → sleep(BACKUP_CHUNK_STREAM_MS)
            → backupJournal.updateJobProgress()
            → backupJournal.syncProgressToRtdb() [debounce 2s]
          onPage({ nextContinuationToken }):
            → Lưu resumeToken = {accountId, continuationToken}
            → backupJournal.updateJobStatus(jobId, 'running', { resumeToken })

  → Nếu includeRtdb:
      → GET /routes từ production RTDB
      → destination.upload(JSON.stringify(routes), 'rtdb-snapshot/routes.json')
      → GET /accounts từ production RTDB
      → destination.upload(JSON.stringify(accounts), 'rtdb-snapshot/accounts.json')

  → updateJobStatus('completed')
  → syncProgressToRtdb (final)
```

---

## 13. Resume logic

Khi user gọi `POST /jobs/:jobId/resume`:

```
backupManager.resumeBackupJob(jobId):
  → getJobById(jobId) → check status = 'paused' | 'failed'
  → Parse resumeToken = { accountId, continuationToken }
  → runBackupJob() với:
      - Bỏ qua tất cả accounts trước accountId đã lưu
      - Với accountId đang dở: dùng continuationToken để tiếp tục scan
      - getPendingLedgerEntries(jobId) → retry các object 'failed' trước
```

---

## 14. Luồng restore đầy đủ

```
User POST /admin/api/backup/restore
  Body: { sourceJobId, sourceDestinationType, sourceDestinationConfig,
           targetAccountMapping, options }

restoreManager.startRestoreJob():
  → Tạo job record trong backup_jobs (type='restore')
  → Tạo sourceDestination adapter
  → Đọc backup_ledger từ SQLite (filter job_id=sourceJobId, status='done')
  → Với mỗi ledger entry:
      → Resolve targetAccount = targetAccountMapping[entry.accountId] || entry.accountId
      → Verify targetAccount tồn tại và có đủ capacity
      → sourceDestination.read(entry.dstKey) → stream
      → proxyRequest PUT vào targetAccount.endpoint với stream
      → commitUploadedObjectMetadata() với targetAccountId
      → syncRouteToRtdb()
      → markLedgerDone() trong restore job
  → Nếu rebuildRtdb:
      → Đọc rtdb-snapshot/accounts.json từ destination
      → rtdbBatchPatch('/accounts', accountsData)
  → updateJobStatus('completed')
```

---

## 15. Backend Replace & Migration — chi tiết luồng

### 15.1 Replace config (không copy data)

Use-case: credentials thay đổi, endpoint thay đổi — data vẫn còn trong backend.

```
POST /admin/api/backup/backends/replace-config
Body: {
  sourceAccountId: "acc01",
  newConfig: { accessKeyId, secretKey, endpoint, region, bucket, ... }
  dryRun: false
}

backendReplacer.replaceBackendConfig():
  → getAccountById(sourceAccountId) → snapshot cũ
  → Lưu snapshot vào backend_migrations.rollback_json
  → upsertAccount({ account_id: sourceAccountId, ...newConfig })
  → reloadAccountsFromSQLite()
  → rtdbBatchPatch('/accounts/sourceAccountId', newRtdbDoc)
  → Log: "Config replaced. Routes unchanged."
  → Return { migrationId, rollbackAvailable: true }
```

### 15.2 Migrate objects (copy sang backend khác)

Use-case: backend cũ bị down hoàn toàn, cần chuyển sang backend mới.

```
POST /admin/api/backup/backends/migrate
Body: {
  sourceAccountId: "acc-broken",
  targetAccountId: "acc-new",
  options: { dryRun, deleteSource, skipExistingByEtag, deactivateSource }
}

backendReplacer.migrateBackendObjects():
  → Tạo migration record
  → getTrackedRoutesByAccount(sourceAccountId)  ← chỉ lấy state != DELETED
  → Với mỗi route (dùng concurrency limit):
      → proxyRequest GET từ sourceAccount
      → proxyRequest PUT lên targetAccount (cùng backend_key format)
      → Verify etag match
      → commitUploadedObjectMetadata({
            encoded_key: route.encoded_key,
            account_id: targetAccountId,     ← thay đổi account
            backend_key: route.backend_key,  ← giữ nguyên key
            ...
        })
      → syncRouteToRtdb()  ← cập nhật production RTDB
      → markLedgerDone() trong migration_ledger
      → Nếu deleteSource: proxyRequest DELETE từ sourceAccount
  → Nếu deactivateSource:
      → UPDATE accounts SET active=0 WHERE account_id=sourceAccountId
      → reloadAccountsFromSQLite()
  → updateMigrationStatus('completed')
```

---

## 16. Logging và monitoring

Mọi backup operation phải log với format structured JSON qua Fastify logger:

```js
logger.info({
  event: 'backup_object_done',
  jobId,
  accountId: account.account_id,
  backendKey,
  sizeBytes,
  durationMs,
  destination: destinationType
}, 'Object backed up')

logger.warn({
  event: 'backup_object_failed',
  jobId,
  accountId: account.account_id,
  backendKey,
  attempt: attemptCount,
  error: err.message
}, 'Object backup failed, will retry')

logger.error({
  event: 'backup_job_failed',
  jobId,
  error: err.message
}, 'Backup job terminated with error')
```

Log prefix cho Dozzle: filter `backup_` events.

---

## 17. Prometheus Metrics mới

Thêm vào `routes/metrics.js`:

```js
backupObjectsTotal: new Counter({
  name: 's3proxy_backup_objects_total',
  help: 'Objects processed by backup system',
  labelNames: ['job_id', 'status', 'destination_type'],
  registers: [register]
}),

backupBytesTotal: new Counter({
  name: 's3proxy_backup_bytes_total',
  help: 'Bytes transferred by backup system',
  labelNames: ['job_id', 'destination_type'],
  registers: [register]
}),

backupJobDurationSeconds: new Histogram({
  name: 's3proxy_backup_job_duration_seconds',
  help: 'Backup job duration',
  labelNames: ['type', 'status'],
  buckets: [60, 300, 600, 1800, 3600, 7200],
  registers: [register]
}),

migrationObjectsTotal: new Counter({
  name: 's3proxy_migration_objects_total',
  help: 'Objects migrated between backends',
  labelNames: ['source_account', 'target_account', 'status'],
  registers: [register]
}),
```

---

## 18. Health check và `GET /health`

Thêm backup status vào response `/health`:

```json
{
  "status": "ok",
  "backup": {
    "enabled": true,
    "rtdbConnected": true,
    "runningJobs": 1,
    "lastCompletedJob": {
      "jobId": "job_xxx",
      "completedAt": 1714000000000,
      "status": "completed",
      "totalObjects": 5000,
      "doneObjects": 5000
    }
  }
}
```

---

## 19. Checklist deploy và kiểm tra

### 19.1 Trước khi deploy

- [ ] Thêm `BACKUP_RTDB_URL`, `BACKUP_CONCURRENCY` vào `.env`
- [ ] Chạy `npm run dockerapp-validate:env` — không có lỗi
- [ ] Verify BACKUP_RTDB_URL có thể read/write (test connection qua `POST /admin/api/backup/config/test`)
- [ ] Thêm `archiver` và `p-limit` vào `package.json` của s3proxy
- [ ] Chạy `npm install` trong `services/s3proxy/`

### 19.2 Sau khi deploy

- [ ] `GET /health` → `backup.enabled: true`, `backup.rtdbConnected: true`
- [ ] Tạo backup job `dryRun: true` → verify log, không có object thực sự được copy
- [ ] Tạo backup job `dryRun: false` với 1 account nhỏ → verify ledger trong SQLite
- [ ] Check BACKUP_RTDB_URL xem có data `/backup/jobs/{jobId}` không
- [ ] Stop job giữa chừng → resume → verify tiếp tục từ đúng điểm
- [ ] Test download ZIP với vài object nhỏ
- [ ] Test check health backend → nhận response đúng format
- [ ] Test replace config với credentials test
- [ ] Monitor Prometheus: `s3proxy_backup_objects_total`, `s3proxy_backup_bytes_total`
- [ ] Verify app response time không tăng trong quá trình backup (BACKUP_CONCURRENCY=3, BACKUP_CHUNK_STREAM_MS=50)

### 19.3 Kiểm tra resume

```bash
# 1. Start backup job
curl -X POST /admin/api/backup/jobs -H "x-api-key: KEY" -d '{...}'
# 2. Đợi ~30s (một số object xong)
# 3. Stop job
curl -X POST /admin/api/backup/jobs/{jobId}/stop -H "x-api-key: KEY"
# 4. Verify status = 'paused' trong DB
sqlite3 .docker-volumes/s3proxy-data/routes.db "SELECT status, resume_token FROM backup_jobs WHERE job_id='{jobId}'"
# 5. Resume
curl -X POST /admin/api/backup/jobs/{jobId}/resume -H "x-api-key: KEY"
# 6. Verify done_objects tăng tiếp (không reset về 0)
```

---

## 20. Thứ tự implement đề xuất cho agent

Implement theo thứ tự sau để có thể test từng bước:

1. **DB schema** — Thêm 4 bảng mới vào `db.js`
2. **config.js** — Thêm BACKUP_* config
3. **backupJournal.js** — CRUD operations cho jobs + ledger (có thể unit test độc lập)
4. **destinations/s3Dest.js** — Destination S3 trước (thông dụng nhất)
5. **backupWorker.js** — Copy 1 object, có retry
6. **backupManager.js** — Orchestrator + concurrency
7. **routes/backup.js** — HTTP endpoints
8. **admin-ui.html** — Thêm backup tab
9. **restoreManager.js**
10. **backendReplacer.js** — Sau cùng vì phức tạp nhất
11. **destinations/gdriveDest.js, onedriveDest.js** — Sau khi S3 ổn định
12. **destinations/zipDest.js** — Cuối cùng

---

## 21. Edge cases cần xử lý

| Case | Xử lý |
|---|---|
| Backend S3 trả 403 trong lúc backup | markLedgerFailed, log warn, tiếp tục object tiếp theo |
| Object bị xóa sau khi đã queue vào ledger | GET trả 404 → status='skipped', không tính là lỗi |
| Destination full (S3 quota hết) | Dừng job, updateJobStatus('failed'), alert webhook |
| App restart trong lúc backup đang chạy | Init: check `getRunningJob()`, nếu có → auto-resume |
| Backup RTDB không accessible | Backup vẫn chạy, chỉ mất realtime sync — SQLite vẫn đủ để resume |
| Migration: source object bị modify giữa chừng | So sánh etag trước và sau copy, nếu lệch → retry |
| ZipDest: client disconnect giữa chừng | Bắt request.raw 'close' event → abort backup job |
| Nhiều job chạy đồng thời | backupManager chỉ cho 1 job chạy cùng lúc, queue các job còn lại |

---

## 22. Cấu trúc thư mục cuối cùng

```
services/s3proxy/src/
  backup/
    backupManager.js
    backupJournal.js
    backupWorker.js
    restoreManager.js
    backendReplacer.js
    destinations/
      index.js
      s3Dest.js
      gdriveDest.js
      onedriveDest.js
      zipDest.js
      localDest.js
  routes/
    backup.js         ← NEW
    admin.js          ← MODIFIED (thêm backup tab vào admin-ui.html)
    health.js         ← MODIFIED (thêm backup status)
    metrics.js        ← MODIFIED (thêm backup metrics)
  admin-ui.html       ← MODIFIED (thêm backup tab)
  config.js           ← MODIFIED
  db.js               ← MODIFIED
  index.js            ← MODIFIED
```

---

*Kế hoạch này đủ chi tiết để agent implement từng file mà không cần hỏi thêm context. Mỗi section trong document tương ứng với một đơn vị công việc độc lập có thể implement và test riêng.*
