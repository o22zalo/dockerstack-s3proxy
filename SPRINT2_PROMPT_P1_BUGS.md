# AGENT PROMPT — SPRINT 2: Fix Important Bugs (P1)
# Backup System — BUG-4, BUG-5, BUG-6
# Prerequisite: Sprint 1 đã hoàn thành và pass tests

---

## CONTEXT

Dự án: `dockerstack-s3proxy` — Node.js ESM · Fastify · better-sqlite3 · Firebase RTDB
Thư mục làm việc: `services/s3proxy/src/`

Bạn sẽ fix **3 bugs quan trọng (P1)**. Đọc kỹ từng mục. Không được thực hiện thứ tự ngẫu nhiên — làm **theo thứ tự BUG-4 → BUG-5 → BUG-6** vì chúng phụ thuộc nhau một phần.

Sau khi hoàn thành, PHẢI viết report theo mẫu ở cuối.

---

## BUG-4: Race condition — stale "running" job block queue mãi mãi

### Vấn đề

Trong `backupManager.js`, hàm `runPendingBackupJobs` (chạy mỗi 2s):

```js
export async function runPendingBackupJobs(logger = console) {
  if (activeJobs.size > 0) return null
  const running = getRunningJob()
  if (running && !activeJobs.has(running.job_id)) return null  // ← DEADLOCK
  ...
}
```

**Scenario deadlock:**
- App crash khi job đang chạy
- Restart: `initBackupManager` reset job về 'pending' ✅
- NHƯNG: nếu giữa crash và restart có window ngắn mà job quay lại 'running' (ví dụ: 2 instance chạy song song), vòng lặp 2s sẽ mãi return null mà không trigger recovery
- Cũng có thể xảy ra nếu `updateJobStatus` lỗi halfway qua

**Thêm vấn đề:** `initBackupManager` chỉ recover một lần khi startup. Sau đó, nếu job stale xuất hiện, không có gì cleanup nó.

### Fix BUG-4: Thêm heartbeat-based recovery trong periodic tick

**File: `services/s3proxy/src/backup/backupManager.js`**

Sửa hàm `runPendingBackupJobs`:

```js
const STALE_JOB_THRESHOLD_MS = 30_000 // 30 giây không heartbeat = stale

export async function runPendingBackupJobs(logger = console) {
  // Guard 1: Nếu đang có job active trong memory → chờ
  if (activeJobs.size > 0) return null

  // Guard 2: Nếu DB có job 'running' nhưng không có trong memory
  const running = getRunningJob()
  if (running) {
    if (activeJobs.has(running.job_id)) {
      // Đang active trong memory → OK, chờ
      return null
    }

    // Không có trong memory → kiểm tra heartbeat
    const heartbeatAge = Date.now() - Number(running.running_heartbeat_at || 0)
    if (heartbeatAge < STALE_JOB_THRESHOLD_MS) {
      // Heartbeat còn mới → có thể process khác đang chạy → chờ
      logger?.debug?.({
        event: 'backup_waiting_for_running_job',
        jobId: running.job_id,
        heartbeatAgeMs: heartbeatAge,
      }, 'job running in another instance, waiting')
      return null
    }

    // Heartbeat stale → job bị crash/zombie → auto-heal
    logger?.warn?.({
      event: 'backup_stale_job_recovery',
      jobId: running.job_id,
      heartbeatAgeMs: heartbeatAge,
      runningInstanceId: running.running_instance_id,
    }, 'stale running job detected, resetting to pending')

    await updateJobStatus(running.job_id, 'pending', {
      completedAt: null,
      lastError: `auto_recovered_stale_heartbeat_${Date.now()}`,
      runningInstanceId: null,
      runningHeartbeatAt: null,
    })
    // Sau khi reset, tiếp tục pick up job trong lần tick này
  }

  // Pick up job pending tiếp theo
  const pendingJob = claimNextPendingJob()
  if (!pendingJob) return null

  // Chạy job trong background — không await
  processBackupJob(pendingJob, logger).catch((err) => {
    logger?.error?.({ event: 'backup_job_unhandled_error', jobId: pendingJob.job_id, err: err.message }, 'unhandled backup job error')
  })

  return pendingJob.job_id
}
```

**Lưu ý:** Hàm `runPendingBackupJobs` hiện tại `return processBackupJob(pendingJob, logger)` (await). Phải đổi thành **không await** để tick interval không bị block:

```js
// TRƯỚC:
return processBackupJob(pendingJob, logger)

// SAU:
processBackupJob(pendingJob, logger).catch((err) => {
  logger?.error?.({ err: err.message }, 'unhandled backup job error')
})
return pendingJob.job_id
```

**Tại sao không await?** Nếu await, interval 2s sẽ không fire timer callback mới trong khi job đang chạy. Điều này vô hại nhưng cũng không check status polling. Job đã có `statusPollTimer` nội bộ → self-managing.

### Fix BUG-4b: Thêm `STALE_JOB_THRESHOLD_MS` vào config

Trong `config.js`, thêm:
```js
BACKUP_STALE_JOB_THRESHOLD_MS: optionalIntAny(['BACKUP_STALE_JOB_THRESHOLD_MS', 'S3PROXY_BACKUP_STALE_JOB_THRESHOLD_MS'], 30000),
```

Trong `.env.example`, thêm:
```env
BACKUP_STALE_JOB_THRESHOLD_MS=30000   # ms không có heartbeat → job bị coi là stale (default: 30000)
```

Sử dụng trong backupManager.js:
```js
const STALE_JOB_THRESHOLD_MS = config.BACKUP_STALE_JOB_THRESHOLD_MS || 30_000
```

### Verify BUG-4

Không thể test tự động dễ dàng, nhưng verify logic bằng cách đọc code:
1. Mở `backupManager.js`, tìm `runPendingBackupJobs`
2. Confirm có đoạn check `heartbeatAge < STALE_JOB_THRESHOLD_MS`
3. Confirm return type không còn là `return processBackupJob(...)` (awaited)
4. Confirm `BACKUP_STALE_JOB_THRESHOLD_MS` có trong config.js và .env.example

---

## BUG-5: backupRunner.js tách riêng — phải document và tích hợp đúng cách

### Vấn đề

Plan (Section 7) yêu cầu gọi `initBackupManager(log)` trong `index.js`. Implementation chọn `backupRunner.js` riêng — đây là design decision hợp lý nhưng gây 2 vấn đề:

1. **Nếu chỉ chạy `node src/index.js`**, jobs sẽ mãi ở `pending` vì không có worker
2. **Không có documentation** về cách deploy backupRunner

### Fix BUG-5a: Tích hợp initBackupManager vào index.js với flag

**File: `services/s3proxy/src/index.js`**

Thêm import:
```js
import { initBackupManager, stopBackupManager } from './backup/backupManager.js'
```

Trong hàm `bootstrap()` (hoặc hàm main), **sau khi** `fastify.listen()` thành công, thêm:

```js
// Sau dòng: await fastify.listen({ port: config.PORT, host: '0.0.0.0' })

// Khởi động backup manager nếu được enable
// Chỉ start nếu BACKUP_ENABLED=true VÀ không chạy trong mode standalone (backupRunner.js)
if (config.BACKUP_ENABLED && !process.env.BACKUP_RUNNER_STANDALONE) {
  const backupManagerResult = initBackupManager(log)
  if (backupManagerResult.started) {
    log.info({ concurrency: config.BACKUP_CONCURRENCY }, 'backup manager started (embedded mode)')
  }
}
```

**Sửa `backupRunner.js`** để set env var khi chạy standalone, tránh conflict nếu cả 2 cùng chạy:

```js
// Thêm vào đầu backupRunner.js, TRƯỚC import:
process.env.BACKUP_RUNNER_STANDALONE = 'true'

import pino from 'pino'
import config from './config.js'
import { initBackupManager } from './backup/backupManager.js'

// ... rest of file
```

**Tại sao:** Nếu deploy Docker với 1 container chạy cả index.js + backupRunner.js subprocess, cả 2 sẽ call `initBackupManager`. Biến `BACKUP_RUNNER_STANDALONE` prevent embedded mode khi standalone đã active.

### Fix BUG-5b: Thêm documentation vào README hoặc docs/

Tạo file `docs/backup-deployment.md`:

```markdown
# Backup System — Deployment Guide

## Architecture

Backup system có 2 thành phần:
1. **HTTP API** (`routes/backup.js`): Tích hợp trong main app, xử lý requests tạo/quản lý jobs
2. **Backup Worker** (`backupRunner.js`): Process xử lý jobs, copy objects sang destination

## Modes

### Mode 1: Embedded (khuyến nghị cho single-container)

Set `BACKUP_ENABLED=true`. Worker sẽ tự động start trong cùng process với main app.

```env
BACKUP_ENABLED=true
BACKUP_CONCURRENCY=2
BACKUP_RTDB_URL=https://your-backup-rtdb.firebasedatabase.app/backup.json?auth=xxx
```

Không cần chạy backupRunner.js riêng.

### Mode 2: Standalone Worker (khuyến nghị cho multi-container)

Set `BACKUP_ENABLED=false` trong main app (để tắt embedded worker).
Chạy backupRunner.js trong container riêng với `BACKUP_ENABLED=true`.

```yaml
# docker-compose example
services:
  s3proxy:
    environment:
      BACKUP_ENABLED: "false"  # Tắt embedded worker

  backup-worker:
    command: node src/backupRunner.js
    environment:
      BACKUP_ENABLED: "true"
      BACKUP_CONCURRENCY: "3"
```

Cả 2 containers chia sẻ cùng SQLite file qua volume mount.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| BACKUP_ENABLED | false | Bật/tắt backup system |
| BACKUP_RTDB_URL | "" | URL Firebase RTDB riêng cho backup (optional) |
| BACKUP_CONCURRENCY | 3 | Số object copy song song |
| BACKUP_CHUNK_STREAM_MS | 50 | Throttle delay giữa objects (ms) |
| BACKUP_MAX_OBJECT_SIZE_MB | 512 | Skip objects lớn hơn mức này |
| BACKUP_STALE_JOB_THRESHOLD_MS | 30000 | Thời gian không heartbeat → job bị coi là crashed |
| BACKUP_ZIP_TMP_DIR | os.tmpdir() | Thư mục lưu ZIP backup tạm thời |

## Lưu ý SQLite multi-process

Cả main app và backup worker đều truy cập cùng file SQLite.
`better-sqlite3` hỗ trợ đọc concurrent nhưng chỉ 1 writer tại 1 thời điểm.
WAL mode giúp giảm contention. Verify trong db.js:
```js
db.pragma('journal_mode = WAL')
```
```

### Verify BUG-5

```bash
# Test mode embedded:
BACKUP_ENABLED=true node src/index.js &
sleep 3

# Tạo 1 job
curl -X POST http://localhost:PORT/admin/backup/jobs \
  -H "x-api-key: KEY" -H "Content-Type: application/json" \
  -d '{"type":"full","destinationType":"local","destinationConfig":{"rootDir":"/tmp/backup-test"}}'

# Chờ 5s, verify job được xử lý (không còn pending)
sleep 5
curl http://localhost:PORT/admin/backup/jobs -H "x-api-key: KEY"
# → status phải là 'running' hoặc 'completed', không phải 'pending'

# Kiểm tra khi BACKUP_RUNNER_STANDALONE=true thì index.js không start embedded:
BACKUP_ENABLED=true BACKUP_RUNNER_STANDALONE=true node -e "
  import('./src/config.js').then(m => {
    const enabled = m.default.BACKUP_ENABLED
    const standalone = process.env.BACKUP_RUNNER_STANDALONE
    console.log('embedded would start:', enabled && !standalone)
  })
"
# → embedded would start: false
```

---

## BUG-6: restoreManager không sync RTDB sau khi restore objects

### Vấn đề

Sau khi restore object vào S3 backend và ghi SQLite qua `commitUploadedObjectMetadata`, routes không được sync lên production Firebase RTDB. Các client đang listen RTDB sẽ không thấy restored objects.

**File:** `services/s3proxy/src/backup/restoreManager.js`

### Fix BUG-6a: Import và gọi RTDB sync sau mỗi object restore

**Tìm cách app hiện tại sync routes lên RTDB.** Kiểm tra `db.js` hoặc `firebase.js` xem có export hàm sync không:

```bash
grep -n "syncRouteToRtdb\|rtdbPatch\|rtdbSet\|patchRoute\|syncRoute" services/s3proxy/src/db.js
grep -n "syncRouteToRtdb\|patchRoute" services/s3proxy/src/firebase.js
grep -rn "syncRouteToRtdb\|patchRoute" services/s3proxy/src/routes/
```

**Tùy theo kết quả tìm được:**

**Nếu tìm thấy `syncRouteToRtdb` hoặc tương tự** trong `firebase.js` hoặc `db.js`:

```js
// Thêm vào đầu restoreManager.js
import { syncRouteToRtdb } from '../firebase.js' // hoặc path phù hợp
```

Trong vòng lặp `for (const entry of ledgerEntries)`, **sau** `commitUploadedObjectMetadata(...)`:

```js
// Sau commitUploadedObjectMetadata:
try {
  await syncRouteToRtdb({
    encodedKey: entry.encoded_key,
    accountId: targetAccountId,
    backendKey: entry.backend_key,
    sizeBytes: sizeBytes,
    etag: entry.src_etag || '',
    contentType: contentType,
  })
} catch (rtdbErr) {
  // RTDB sync failure không được làm fail restore — chỉ log warning
  logger.warn?.({ restoreId, key: entry.backend_key, err: rtdbErr.message }, 'restore: RTDB sync failed (non-fatal)')
}
```

**Nếu KHÔNG tìm thấy function riêng** (RTDB sync được thực hiện inline), implement bằng cách gọi trực tiếp:

```js
// Thêm import
import { rtdbPatch } from '../firebase.js'  // hoặc tên function thực tế

// Sau commitUploadedObjectMetadata:
try {
  // Đọc route vừa được commit từ SQLite để lấy đúng data
  const restoredRoute = getRouteByEncodedKey(entry.encoded_key) // tìm function phù hợp trong db.js
  if (restoredRoute) {
    await rtdbPatch(`/routes/${entry.encoded_key}`, {
      accountId: targetAccountId,
      backendKey: entry.backend_key,
      sizeBytes: sizeBytes,
      etag: entry.src_etag || '',
      contentType: contentType,
      restoredAt: Date.now(),
    })
  }
} catch (rtdbErr) {
  logger.warn?.({ key: entry.backend_key, err: rtdbErr.message }, 'restore: RTDB sync failed (non-fatal)')
}
```

**Quan trọng:** RTDB sync failure **không được** làm throw exception hoặc fail restore. Wrap trong try/catch và chỉ log warning. Restore thành công là khi S3 object + SQLite metadata đã được ghi đúng.

### Fix BUG-6b: Batch RTDB sync sau khi restore xong (optional optimization)

Nếu số lượng entries lớn (>1000), sync từng entry sẽ chậm. Thêm batch option:

```js
// Trong startRestoreJob, sau vòng lặp ledgerEntries:
if (options.rebuildRtdb && restored > 0) {
  try {
    // Patch toàn bộ routes đã restore lên RTDB một lần
    logger.info?.({ restoreId, count: restored }, 'restore: syncing all routes to RTDB')
    // Implement batch patch nếu có hàm tương ứng, hoặc bỏ qua nếu quá phức tạp
  } catch (err) {
    logger.warn?.({ restoreId, err: err.message }, 'restore: batch RTDB sync failed (non-fatal)')
  }
}
```

### Fix BUG-6c: Thêm `rebuildRtdb` option vào restore response

Sửa return value của `startRestoreJob` để include thông tin RTDB sync:

```js
return {
  restoreId,
  sourceJobId,
  status: failed > 0 ? 'completed_with_errors' : 'completed',
  totalObjects: ledgerEntries.length,
  restoredObjects: restored,
  failedObjects: failed,
  rtdbSynced: restored - rtdbSyncFailures,  // thêm counter này
  rtdbSyncFailures: rtdbSyncFailures,         // thêm counter này
  dryRun,
  errors: errors.slice(0, 50),
}
```

Thêm `let rtdbSyncFailures = 0` vào đầu hàm, và increment khi catch RTDB error.

### Verify BUG-6

```bash
# Kiểm tra import đã có
grep -n "syncRouteToRtdb\|rtdbPatch\|firebase" services/s3proxy/src/backup/restoreManager.js

# Chạy restore job (cần có backup job hoàn thành trước)
curl -X POST http://localhost:PORT/admin/backup/restore \
  -H "x-api-key: KEY" -H "Content-Type: application/json" \
  -d '{
    "sourceJobId": "job_xxx",
    "sourceDestinationType": "local",
    "sourceDestinationConfig": {"rootDir": "/tmp/backup-test"},
    "targetAccountMapping": {},
    "options": {"dryRun": true}
  }'
# → Response phải có rtdbSynced và rtdbSyncFailures fields

# Verify không có throw unhandled (chỉ warning logs khi RTDB unavailable)
```

---

## CLEANUP SAU KHI FIX 3 BUGS

### Kiểm tra WAL mode trong db.js

Mở `services/s3proxy/src/db.js`, tìm:
```bash
grep -n "WAL\|journal_mode\|pragma" services/s3proxy/src/db.js
```

Nếu **không có** `journal_mode = WAL`, thêm vào ngay sau khi open database:
```js
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')  // balance giữa safety và performance
```

Điều này quan trọng khi cả main app và backupRunner đọc/ghi SQLite đồng thời.

### Run tests
```bash
cd services/s3proxy
npm test 2>&1 | tail -30
```

### Lint
```bash
npm run lint 2>/dev/null || echo "no lint configured"
```

---

## BÁO CÁO BẮT BUỘC

Tạo file `docs/SPRINT2_IMPLEMENTATION_REPORT.md`:

```markdown
# Sprint 2 Implementation Report — P1 Bug Fixes
> Ngày: YYYY-MM-DD | Agent: [tên/version]

## Tóm tắt

## BUG-4: Stale job race condition

### Thay đổi trong backupManager.js
- [ ] `runPendingBackupJobs` có heartbeat age check
- [ ] STALE_JOB_THRESHOLD_MS = config value
- [ ] processBackupJob được gọi không await (fire-and-forget)
- [ ] Log warning khi detect stale job
- Đoạn code mới của runPendingBackupJobs (paste toàn bộ function):
  ```js
  [paste here]
  ```

### Thay đổi trong config.js
- [ ] BACKUP_STALE_JOB_THRESHOLD_MS đã được thêm

### Thay đổi trong .env.example
- [ ] BACKUP_STALE_JOB_THRESHOLD_MS đã được thêm

## BUG-5: backupRunner standalone documentation

### Thay đổi trong index.js
- [ ] Import initBackupManager, stopBackupManager
- [ ] Gọi initBackupManager sau listen() với guard BACKUP_ENABLED && !BACKUP_RUNNER_STANDALONE
- Đoạn code thêm vào (paste):
  ```js
  [paste here]
  ```

### Thay đổi trong backupRunner.js
- [ ] Set BACKUP_RUNNER_STANDALONE=true ở đầu file

### Tài liệu
- [ ] docs/backup-deployment.md đã tạo
- Nội dung có đề cập: embedded mode, standalone mode, WAL mode: [yes/no]

### Verify embedded mode
- Job tạo và được xử lý khi chỉ chạy index.js: [yes/no/không test được - lý do]

## BUG-6: restoreManager RTDB sync

### Function RTDB sync tìm được
- Tên function: [...]
- File: [...]
- Cách gọi: [...]

### Thay đổi trong restoreManager.js
- [ ] Import RTDB sync function
- [ ] Gọi sync sau mỗi commitUploadedObjectMetadata
- [ ] RTDB failure wrapped trong try/catch (non-fatal)
- [ ] Response có rtdbSynced và rtdbSyncFailures fields
- Đoạn code sync (paste):
  ```js
  [paste here]
  ```

### WAL mode trong db.js
- [ ] `journal_mode = WAL` đã có (hoặc đã thêm)

## Test results
- Total: [số] | Passed: [số] | Failed: [số]
- Test failures do sprint này: [có/không]

## So sánh với prompt gốc (Sprint 2)
| Hạng mục trong prompt | Đã làm | Ghi chú |
|---|---|---|
| BUG-4: heartbeat age check | ✅/❌ | |
| BUG-4: fire-and-forget processBackupJob | ✅/❌ | |
| BUG-4: config BACKUP_STALE_JOB_THRESHOLD_MS | ✅/❌ | |
| BUG-4: .env.example update | ✅/❌ | |
| BUG-5: index.js embedded mode | ✅/❌ | |
| BUG-5: BACKUP_RUNNER_STANDALONE guard | ✅/❌ | |
| BUG-5: docs/backup-deployment.md | ✅/❌ | |
| BUG-6: import RTDB sync | ✅/❌ | |
| BUG-6: sync sau commitUploadedObjectMetadata | ✅/❌ | |
| BUG-6: non-fatal try/catch | ✅/❌ | |
| BUG-6: rtdbSynced field trong response | ✅/❌ | |
| WAL mode trong db.js | ✅/❌ | |
| npm test pass | ✅/❌ | |

## Vấn đề gặp phải
[...]

## Deviation so với prompt (nếu có)
[...]
```

---

**NHẮC NHỞ:** Trước khi submit report, search lại:
```bash
grep -n "BACKUP_RUNNER_STANDALONE\|initBackupManager\|stale_heartbeat\|rtdbSynced" \
  services/s3proxy/src/index.js \
  services/s3proxy/src/backupRunner.js \
  services/s3proxy/src/backup/backupManager.js \
  services/s3proxy/src/backup/restoreManager.js
```
Mỗi keyword phải xuất hiện ít nhất 1 lần trong file phù hợp.
