# AGENT PROMPT — SPRINT 3: Fix P2 Bugs + Performance Improvements
# Backup System — BUG-7, BUG-8, BUG-9 + 4 cải tiến hiệu năng
# Prerequisite: Sprint 1 và Sprint 2 đã hoàn thành

---

## CONTEXT

Dự án: `dockerstack-s3proxy` — Node.js ESM · Fastify · better-sqlite3 · Firebase RTDB
Thư mục làm việc: `services/s3proxy/src/`

Sprint này bao gồm **3 bugs P2** và **4 cải tiến hiệu năng**. Làm theo thứ tự trong prompt. Tất cả thay đổi phải được report đầy đủ.

---

## BUG-7: GDriveDestination.read() mất state sau restart

### Vấn đề

```js
// gdriveDest.js
this._keyToFileId = new Map()  // In-memory only — mất khi restart
```

`read(key)` tra cứu `_keyToFileId` map. Sau restart, map rỗng → throw `"fileId not found"` → không thể restore từ GDrive.

Plan đề cập: lưu index trong `backup_ledger.dst_location` (format `gdrive://folderId/fileId`).

### Fix BUG-7: Lookup fileId từ dst_location thay vì in-memory map

**File: `services/s3proxy/src/backup/destinations/gdriveDest.js`**

**Bước 1:** Thêm static helper để parse fileId từ dst_location:

```js
// Thêm static method vào class GDriveDestination:
static extractFileId(dstLocation) {
  // Format: gdrive://folderId/fileId
  if (!dstLocation) return null
  const match = String(dstLocation).match(/^gdrive:\/\/[^/]+\/(.+)$/)
  return match ? match[1] : null
}
```

**Bước 2:** Sửa `read(key)` để accept cả fileId trực tiếp hoặc dstLocation:

```js
async read(key, { dstLocation = null } = {}) {
  const token = await this._getToken()

  // Ưu tiên: in-memory map (nếu có, session hiện tại)
  let fileId = this._keyToFileId.get(key)

  // Fallback: parse từ dstLocation (sau restart)
  if (!fileId && dstLocation) {
    fileId = GDriveDestination.extractFileId(dstLocation)
  }

  // Fallback cuối: tìm kiếm trên GDrive theo description=key
  if (!fileId) {
    fileId = await this._findFileIdByDescription(key)
  }

  if (!fileId) throw new Error(`GDrive: fileId not found for key: ${key}. Provide dstLocation or ensure file exists.`)

  const res = await fetch(`${GDRIVE_FILES_BASE}/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`GDrive read failed ${res.status}`)
  return res.body
}

// Helper: tìm file theo description (metadata field lưu original key)
async _findFileIdByDescription(key) {
  const token = await this._getToken()
  const params = new URLSearchParams({
    q: `'${this.folderId}' in parents and description='${key}' and trashed=false`,
    fields: 'files(id,description)',
    pageSize: '1',
  })
  try {
    const res = await fetch(`${GDRIVE_FILES_BASE}?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return null
    const data = await res.json()
    const file = data.files?.[0]
    if (file) {
      this._keyToFileId.set(key, file.id) // cache lại
      return file.id
    }
  } catch { /* ignore */ }
  return null
}
```

**Bước 3:** Sửa `restoreManager.js` để pass `dstLocation` khi gọi `read`:

```js
// Trong restoreManager.js, tìm:
const readStream = await sourceDest.read(entry.dst_key)

// Sửa thành:
const readStream = await sourceDest.read(entry.dst_key, { dstLocation: entry.dst_location })
```

**Bước 4:** Tương tự sửa `exists()` và `getMetadata()` để fallback từ dstLocation:

```js
async exists(key, { dstLocation = null } = {}) {
  if (this._keyToFileId.has(key)) return true
  if (dstLocation) {
    const fileId = GDriveDestination.extractFileId(dstLocation)
    if (fileId) { this._keyToFileId.set(key, fileId); return true }
  }
  const found = await this._findFileIdByDescription(key)
  return Boolean(found)
}
```

### Verify BUG-7
```bash
# Unit test manual: tạo GDriveDestination, set _keyToFileId rỗng, gọi read với dstLocation
node -e "
import('./src/backup/destinations/gdriveDest.js').then(({ GDriveDestination }) => {
  const fileId = GDriveDestination.extractFileId('gdrive://folder123/file456')
  console.log('extractFileId test:', fileId === 'file456' ? 'PASS' : 'FAIL', fileId)
})
"
```

---

## BUG-8: Route path prefix không đồng nhất với plan

### Vấn đề

- **Plan:** `/admin/api/backup/...`
- **Implementation:** `/admin/backup/...`

Admin-UI đang gọi `/admin/backup/...` và hoạt động đúng. Thay đổi path sẽ break UI. Quyết định: **KHÔNG thay đổi route path** — thay vào đó cập nhật docs cho đúng với implementation.

### Fix BUG-8: Cập nhật docs/BACKUP_SYSTEM_PLAN.md

Tìm tất cả occurrences `/admin/api/backup` trong plan:
```bash
grep -n "/admin/api/backup" docs/BACKUP_SYSTEM_PLAN.md
```

Thêm note ở đầu Section 5.11 trong plan hoặc tạo addendum:

Tạo file `docs/BACKUP_API_REFERENCE.md`:

```markdown
# Backup API Reference

> Lưu ý: Implementation sử dụng path prefix `/admin/backup/` (không có `/api/`).
> Plan ban đầu ghi `/admin/api/backup/` — đây là deviation có chủ ý để đồng nhất
> với các admin endpoints khác trong project (VD: `/admin/accounts/`, `/admin/cron/`).

## Endpoints

### Jobs

| Method | Path | Mô tả |
|---|---|---|
| GET | /admin/backup/jobs | List backup jobs |
| POST | /admin/backup/jobs | Tạo backup job mới |
| GET | /admin/backup/jobs/:jobId | Lấy status job |
| POST | /admin/backup/jobs/:jobId/stop | Stop job |
| POST | /admin/backup/jobs/:jobId/pause | Pause job |
| POST | /admin/backup/jobs/:jobId/resume | Resume job |
| DELETE | /admin/backup/jobs/:jobId | Xóa job record |
| GET | /admin/backup/jobs/:jobId/ledger | Xem ledger (phân trang) |
| GET | /admin/backup/jobs/:jobId/download | Download ZIP (chỉ cho zip jobs) |
| GET | /admin/backup/jobs/:jobId/events | SSE stream cho live progress |

### Restore

| Method | Path | Mô tả |
|---|---|---|
| POST | /admin/backup/restore | Tạo restore job |
| GET | /admin/backup/restore/:jobId/verify | Verify integrity |

### Backend Management

| Method | Path | Mô tả |
|---|---|---|
| GET | /admin/backup/backends/:accountId/health | Check health |
| GET | /admin/backup/backends/:accountId/diagnose | Full diagnose |
| POST | /admin/backup/backends/replace-config | Thay config không copy |
| POST | /admin/backup/backends/migrate | Copy objects sang backend khác |
| GET | /admin/backup/backends/migrations | List migrations |
| POST | /admin/backup/backends/migrations/:id/rollback | Rollback |

### Config

| Method | Path | Mô tả |
|---|---|---|
| GET | /admin/backup/config | Lấy cấu hình backup hiện tại |
| POST | /admin/backup/config/test | Test RTDB connection |

## Authentication

Tất cả endpoints yêu cầu header `x-api-key: <ADMIN_API_KEY>`.

## Request Body Examples

### POST /admin/backup/jobs — S3 destination
```json
{
  "type": "full",
  "destinationType": "s3",
  "destinationConfig": {
    "endpoint": "https://backup.supabase.co/storage/v1/s3",
    "accessKeyId": "key-id",
    "secretKey": "secret",
    "bucket": "backups",
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

### POST /admin/backup/jobs — Multi-destination
```json
{
  "type": "full",
  "destinationType": "s3",
  "destinationConfig": {
    "destinations": [
      {"type": "s3", "config": {"endpoint": "...", "bucket": "backup-primary"}},
      {"type": "local", "config": {"rootDir": "/backup-local"}}
    ]
  }
}
```

### POST /admin/backup/restore
```json
{
  "sourceJobId": "job_abc123",
  "sourceDestinationType": "s3",
  "sourceDestinationConfig": {
    "endpoint": "https://backup.supabase.co/storage/v1/s3",
    "accessKeyId": "key-id",
    "secretKey": "secret",
    "bucket": "backups"
  },
  "targetAccountMapping": {
    "old-account-id": "new-account-id"
  },
  "options": {
    "dryRun": false,
    "rebuildRtdb": true
  }
}
```
```

---

## BUG-9: BACKUP_ENABLED=false nhưng routes vẫn nhận requests

### Vấn đề

Khi `BACKUP_ENABLED=false`:
- `backupRunner.js` tự exit ✅
- Nhưng `routes/backup.js` vẫn active → User có thể tạo jobs, jobs sẽ mãi `pending`
- Confusing UX: tạo job thành công (202) nhưng không bao giờ được xử lý

### Fix BUG-9: Thêm guard trong routes/backup.js

**File: `services/s3proxy/src/routes/backup.js`**

Thêm ở đầu function `backupRoutes`, **sau** `fastify.addHook('preHandler', fastify.authenticate)`:

```js
export default async function backupRoutes(fastify) {
  fastify.addHook('preHandler', fastify.authenticate)

  // Guard: Trả 503 nếu BACKUP_ENABLED=false
  // Exception: GET /config và GET /config/test vẫn cho phép để kiểm tra setup
  fastify.addHook('preHandler', async (request, reply) => {
    if (config.BACKUP_ENABLED) return // Enabled → OK
    
    // Cho phép config endpoints để debug
    const allowedWhenDisabled = [
      '/admin/backup/config',
    ]
    if (allowedWhenDisabled.some(path => request.routerPath === path || request.url === path)) {
      return // Allow
    }

    reply.code(503).send({
      ok: false,
      error: 'BACKUP_DISABLED',
      message: 'Backup system is disabled. Set BACKUP_ENABLED=true to enable.',
      configEndpoint: '/admin/backup/config',
    })
  })

  // ... rest of routes (không thay đổi gì khác)
```

**Lưu ý về `request.routerPath`:** Fastify cung cấp `request.routerPath` là path pattern (có `:param`). Dùng `request.url` nếu muốn match exact URL. Kiểm tra fastify version để biết property đúng:

```bash
grep "\"fastify\"" services/s3proxy/package.json
```

Với Fastify v4+: `request.routerPath` có dạng `/admin/backup/config`.

### Verify BUG-9
```bash
# Test với BACKUP_ENABLED=false (default trong .env.example)
curl -X POST http://localhost:PORT/admin/backup/jobs \
  -H "x-api-key: KEY" -H "Content-Type: application/json" \
  -d '{"type":"full","destinationType":"local"}'
# → Phải nhận 503 {"ok":false,"error":"BACKUP_DISABLED",...}

# Config endpoint vẫn hoạt động
curl http://localhost:PORT/admin/backup/config -H "x-api-key: KEY"
# → Phải nhận 200 với backupEnabled: false
```

---

## PERF-1: Batch upsert ledger entries per page

### Vấn đề

Mỗi object gọi `upsertLedgerEntry` 1 lần → 10,000 objects = 10,000 individual SQLite writes. SQLite autocommit mode rất chậm cho writes riêng lẻ.

### Fix

**File: `services/s3proxy/src/backup/backupJournal.js`**

Thêm function batch upsert:

```js
// Thêm vào backupJournal.js
export const batchUpsertLedgerEntries = db.transaction((entries) => {
  for (const entry of entries) {
    stmts.upsertLedger.run(entry)
  }
})
```

**File: `services/s3proxy/src/backup/backupManager.js`**

Import và sử dụng:
```js
import {
  // ... existing imports ...
  batchUpsertLedgerEntries,   // ← thêm
} from './backupJournal.js'
```

Trong `processBackupJob`, trong `onPage` callback, thay vì upsert từng object trong task:

```js
// TRƯỚC: upsertLedgerEntry gọi trong mỗi task riêng lẻ

// SAU: Collect entries của 1 page, batch upsert trước khi dispatch tasks
onPage: async ({ objects, nextContinuationToken }) => {
  // Batch insert ledger entries cho toàn bộ page này trước
  const pageEntries = []
  for (const object of objects) {
    // ... existing checks (aborted, too large, ledgerProcessedKeys) ...
    for (const destination of destinations) {
      pageEntries.push({
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
    }
  }
  // 1 transaction cho toàn page (có thể 1000 objects) thay vì 1000 transactions
  if (pageEntries.length > 0) {
    batchUpsertLedgerEntries(pageEntries)
  }

  // Sau đó mới dispatch copy tasks
  for (const object of objects) {
    // ... existing task dispatch logic, nhưng KHÔNG gọi upsertLedgerEntry nữa (đã batch ở trên)
  }
}
```

**Quan trọng:** Sau khi thêm batch upsert, xóa hoặc comment out `upsertLedgerEntry(...)` calls bên trong vòng lặp task để tránh duplicate.

---

## PERF-2: Thêm composite index cho getPendingLedgerEntries

**File: `services/s3proxy/src/db.js`**

Trong phần `db.exec(...)` migration hoặc sau `ensureColumn(...)` block, thêm:

```js
// Thêm vào migration block
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_backup_ledger_job_status_id 
    ON backup_ledger(job_id, status, id);
`)
```

**Lý do:** Query `getPendingLedgerEntries` filter `job_id=? AND status IN ('pending','failed') AND id > ?`. Index composite `(job_id, status, id)` giúp query này chạy nhanh hơn nhiều với ledger lớn (>100k rows).

Thêm sau các ensureColumn calls hiện có:

```js
// Thêm vào cuối phần db.exec migration
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_backup_ledger_job_status_id 
    ON backup_ledger(job_id, status, id);
  CREATE INDEX IF NOT EXISTS idx_backend_migrations_created 
    ON backend_migrations(created_at DESC);
`)
```

---

## PERF-3: Throttle updateJobProgress — không gọi mỗi object

### Vấn đề

`updateJobProgress` được gọi sau mỗi object → N objects = N SQLite writes cho progress. Với 10,000 objects và concurrency 3, có thể 3,000+ writes/minute chỉ để update progress.

### Fix

**File: `services/s3proxy/src/backup/backupManager.js`**

Trong `processBackupJob`, thêm throttle cho progress flush:

```js
// Thêm vào đầu processBackupJob (sau khai báo progress object):
let lastProgressFlushAt = 0
const PROGRESS_FLUSH_INTERVAL_MS = 3000 // Flush progress mỗi 3 giây tối đa

const flushProgressIfNeeded = async (force = false) => {
  const now = Date.now()
  if (!force && (now - lastProgressFlushAt) < PROGRESS_FLUSH_INTERVAL_MS) return
  lastProgressFlushAt = now
  await updateJobProgress(job.job_id, progress)
}
```

Thay tất cả `await updateJobProgress(job.job_id, progress)` trong vòng lặp scan bằng:
```js
await flushProgressIfNeeded()
```

Chỉ gọi forced flush tại những điểm quan trọng:
```js
// Force flush khi: job completed, job failed, sau mỗi page, trước return
await flushProgressIfNeeded(true) // force=true
```

**Kết quả:** Progress cập nhật mỗi 3 giây thay vì mỗi object. UI vẫn mượt vì poll interval > 1 giây.

---

## PERF-4: migrationObjectsTotal metric chưa được gọi

**File: `services/s3proxy/src/backup/backendReplacer.js`**

Thêm import metrics:
```js
import { metrics } from '../routes/metrics.js'
```

Trong `migrateBackendObjects`, trong hàm `migrateOne`, sau khi copy thành công:
```js
// Sau done += 1:
metrics.migrationObjectsTotal.inc({
  source_account: sourceAccountId,
  target_account: targetAccountId,
  status: 'done',
})

// Và sau failed += 1:
metrics.migrationObjectsTotal.inc({
  source_account: sourceAccountId,
  target_account: targetAccountId,
  status: 'failed',
})
```

---

## CLEANUP

### Verify tất cả thay đổi

```bash
# BUG-7: GDrive extractFileId
grep -n "extractFileId\|_findFileIdByDescription\|dstLocation" \
  services/s3proxy/src/backup/destinations/gdriveDest.js

# BUG-8: API reference doc
ls -la docs/BACKUP_API_REFERENCE.md

# BUG-9: BACKUP_DISABLED guard
grep -n "BACKUP_DISABLED\|BACKUP_ENABLED" services/s3proxy/src/routes/backup.js

# PERF-1: batch upsert
grep -n "batchUpsertLedgerEntries\|db.transaction" services/s3proxy/src/backup/backupJournal.js

# PERF-2: new index
grep -n "idx_backup_ledger_job_status_id" services/s3proxy/src/db.js

# PERF-3: throttle progress
grep -n "flushProgressIfNeeded\|PROGRESS_FLUSH_INTERVAL" services/s3proxy/src/backup/backupManager.js

# PERF-4: migrationObjectsTotal
grep -n "migrationObjectsTotal" services/s3proxy/src/backup/backendReplacer.js
```

Tất cả lệnh trên phải cho output có ít nhất 1 match. Nếu không có match → chưa làm xong.

### Run tests
```bash
cd services/s3proxy && npm test 2>&1 | tail -30
```

---

## BÁO CÁO BẮT BUỘC

Tạo `docs/SPRINT3_IMPLEMENTATION_REPORT.md`:

```markdown
# Sprint 3 Implementation Report — P2 Bugs + Performance
> Ngày: YYYY-MM-DD | Agent: [tên/version]

## Tóm tắt

## BUG-7: GDrive read sau restart

- [ ] `GDriveDestination.extractFileId(dstLocation)` static method
- [ ] `_findFileIdByDescription(key)` helper method
- [ ] `read()` fallback chain: memory → dstLocation → GDrive search
- [ ] `exists()` fallback tương tự
- [ ] `restoreManager.js` pass `dstLocation` khi gọi `read()`
- Unit test kết quả:
  ```
  [paste output của node test ở trên]
  ```

## BUG-8: API path documentation

- [ ] `docs/BACKUP_API_REFERENCE.md` đã tạo
- Số endpoints được document: [số]
- Có đề cập path prefix `/admin/backup/` (không có `/api/`): [yes/no]

## BUG-9: BACKUP_ENABLED guard

- [ ] Guard added trong backupRoutes
- [ ] `/admin/backup/config` vẫn accessible khi BACKUP_ENABLED=false
- [ ] POST /admin/backup/jobs trả 503 khi disabled
- Verify output:
  ```
  [paste curl output]
  ```

## PERF-1: Batch ledger upsert

- [ ] `batchUpsertLedgerEntries` transaction added trong backupJournal.js
- [ ] Import trong backupManager.js
- [ ] Upsert calls trong vòng lặp scan đã được batch
- [ ] Duplicate upsert calls đã được xóa
- Ước tính improvement: [1 transaction/page vs N transactions/page]

## PERF-2: Composite index

- [ ] `idx_backup_ledger_job_status_id` đã thêm vào db.js
- [ ] `idx_backend_migrations_created` đã thêm
- grep output:
  ```
  [paste]
  ```

## PERF-3: Progress throttle

- [ ] `flushProgressIfNeeded()` helper function
- [ ] `PROGRESS_FLUSH_INTERVAL_MS = 3000`
- [ ] Replaced `updateJobProgress` calls trong vòng lặp
- [ ] Force flush ở các điểm quan trọng

## PERF-4: migrationObjectsTotal metric

- [ ] Import metrics trong backendReplacer.js
- [ ] Increment sau done
- [ ] Increment sau failed

## Verify commands output
```bash
[paste output của tất cả grep commands ở section CLEANUP]
```

## Test results
- Total: [số] | Passed: [số] | Failed: [số]

## So sánh với prompt gốc (Sprint 3)
| Hạng mục | Đã làm | Ghi chú |
|---|---|---|
| BUG-7: extractFileId static | ✅/❌ | |
| BUG-7: _findFileIdByDescription | ✅/❌ | |
| BUG-7: read() fallback chain | ✅/❌ | |
| BUG-7: restoreManager pass dstLocation | ✅/❌ | |
| BUG-8: BACKUP_API_REFERENCE.md | ✅/❌ | |
| BUG-9: 503 guard | ✅/❌ | |
| BUG-9: config endpoint bypass | ✅/❌ | |
| PERF-1: batchUpsertLedgerEntries | ✅/❌ | |
| PERF-1: removed duplicate upserts | ✅/❌ | |
| PERF-2: composite index | ✅/❌ | |
| PERF-3: flushProgressIfNeeded | ✅/❌ | |
| PERF-4: migrationObjectsTotal | ✅/❌ | |
| verify grep all match | ✅/❌ | |
| npm test pass | ✅/❌ | |

## Vấn đề gặp phải
[...]

## Deviation so với prompt
[...]
```

---

**NHẮC NHỞ CUỐI:** Chạy lại tất cả grep commands trong section CLEANUP và paste output vào report. Không được có hạng mục nào trong bảng "So sánh" là ❌ mà không có giải thích cụ thể.
