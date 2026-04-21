# AGENT PROMPT — SPRINT 6: P1 Improvements
# Backup System — FIX-1 (s3Dest streaming), FIX-2 (restore job tracking)
# Prerequisite: Sprint 5 đã hoàn thành và npm test pass

---

## CONTEXT

Dự án: `dockerstack-s3proxy` — Node.js ESM · Fastify · better-sqlite3 · Firebase RTDB
Thư mục làm việc: `services/s3proxy/src/`

Sprint này thực hiện **2 cải tiến kỹ thuật (P1)** được phát hiện qua review sau Sprint 1–5:

- **FIX-1:** `s3Dest.js` đang buffer objects ≤5MB vào RAM thay vì stream thẳng → gây RAM spike khi nhiều concurrent backup.
- **FIX-2:** `restoreManager` không ghi job record vào `backup_jobs` → không thể track lịch sử restore qua API.

Thực hiện **theo thứ tự FIX-1 → FIX-2**. Đọc toàn bộ file trước khi sửa.

Sau khi hoàn thành, PHẢI viết report vào `docs/SPRINT6_IMPLEMENTATION_REPORT.md`.

---

## FIX-1: `s3Dest.js` — Buffer RAM → Streaming PutObject cho objects nhỏ

### Vấn đề

Trong `backup/destinations/s3Dest.js`, hàm `upload()` hiện tại dùng 2 path:

```js
async upload({ stream, key, contentType, size, signal }) {

  // Path A: size <= 5MB → BUFFER TOÀN BỘ VÀO RAM (SAI)
  if ((Number(size) || 0) <= 5 * 1024 * 1024) {
    const chunks = []
    for await (const chunk of stream) chunks.push(toBuffer(chunk))
    const body = Buffer.concat(chunks)   // ← spike RAM: 5MB × concurrency
    await this.client.send(new PutObjectCommand({ Body: body, ... }))
    return { ... }
  }

  // Path B: size > 5MB → multipart upload (đúng, không buffer)
  const create = await this.client.send(new CreateMultipartUploadCommand(...))
  ...
}
```

**Hậu quả cụ thể với config mặc định:**
- `BACKUP_CONCURRENCY=3`, objects ~4.9MB (dưới ngưỡng 5MB)
- Peak RAM từ buffer: `3 × 5MB = 15MB` per backup job, chạy song song với S3 request path của app
- Thực tế nguy hiểm hơn: nếu `size` không được truyền vào (undefined) → `Number(undefined) = NaN` → `NaN <= 5*1024*1024 = false` → vào path multipart thay vì PutObject → không stream được → partial upload

**Nguyên nhân Sprint 1 chỉ fix `restoreManager` và `backendReplacer` mà bỏ sót `s3Dest.js`:** Sprint 1 tập trung fix RAM buffer trong flow restore/migrate, nhưng `s3Dest` là destination adapter cho backup (chiều ngược lại), report Sprint 1 đã ghi nhận là "known issue".

### Fix FIX-1: Dùng stream trực tiếp cho PutObject

**File: `services/s3proxy/src/backup/destinations/s3Dest.js`**

Đọc toàn bộ file trước. Sau đó sửa hàm `upload()`:

Tìm đoạn Path A (buffer nhỏ) và thay **toàn bộ Path A** bằng PutObject stream:

```js
// TRƯỚC — Path A buffer:
  if ((Number(size) || 0) <= 5 * 1024 * 1024) {
    const chunks = []
    for await (const chunk of stream) chunks.push(toBuffer(chunk))
    const body = Buffer.concat(chunks)
    const response = await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: targetKey,
      Body: body,
      ContentType: contentType,
    }), { abortSignal: signal })
    return { key: targetKey, location: `s3://${this.bucket}/${targetKey}`, etag: response.ETag?.replace(/\"/g, '') || '' }
  }
```

```js
// SAU — stream trực tiếp, không buffer:
  if ((Number(size) || 0) <= 5 * 1024 * 1024) {
    const response = await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: targetKey,
      Body: stream,
      ContentType: contentType,
      ContentLength: (Number(size) || undefined),
    }), { abortSignal: signal })
    return { key: targetKey, location: `s3://${this.bucket}/${targetKey}`, etag: response.ETag?.replace(/\"/g, '') || '' }
  }
```

**Lưu ý kỹ thuật quan trọng:**

1. `@aws-sdk/client-s3` v3 chấp nhận `Body` là `Readable`, `ReadableStream`, `Blob`, `Buffer`, hoặc `string`. Truyền stream trực tiếp là đúng.
2. `ContentLength` phải được truyền khi dùng stream để S3 biết kích thước. Dùng `Number(size) || undefined` — nếu `size=0` hoặc falsy thì bỏ (để S3 tự detect qua chunked transfer).
3. Path B (multipart upload) **không sửa** — đã hoạt động đúng.
4. Hàm helper `toBuffer()` sau khi sửa có thể không còn dùng trong `upload()`. **Không xóa** — vẫn dùng trong Path B (multipart buffering từng part là cần thiết).

**Sau khi sửa, verify không còn `Buffer.concat` trong Path A:**

```bash
grep -n "Buffer.concat\|chunks.push\|for await.*stream.*chunk" \
  services/s3proxy/src/backup/destinations/s3Dest.js
```

Chỉ được thấy `Buffer.concat` trong phần multipart (Path B), không được thấy trong Path A (trước `const create = await ...`).

---

## FIX-2: `restoreManager` — Ghi job record vào `backup_jobs`

### Vấn đề

Hiện tại `startRestoreJob()` chỉ return object tạm:

```js
// restoreManager.js — hiện tại:
export async function startRestoreJob({ sourceJobId, ... }) {
  const restoreId = `restore_${randomUUID()}`  // ← ID tạm, không lưu DB

  // ... thực hiện restore ...

  return {
    restoreId,
    status: 'completed',
    ...
  }
}
```

**Hậu quả:**
- `GET /admin/backup/jobs` không bao giờ hiển thị restore jobs.
- Sau khi `startRestoreJob()` return, không còn cách nào query lại kết quả.
- Nếu restore fail giữa chừng → mất toàn bộ context.

### Fix FIX-2: Persist restore job vào `backup_jobs` (type='restore')

**File: `services/s3proxy/src/backup/restoreManager.js`**

**Bước 1:** Thêm import `createBackupJob` và `updateJobStatus`, `updateJobProgress` từ `backupJournal.js`:

```js
// TRƯỚC — import từ backupJournal:
import { listLedgerEntries, getJobById } from './backupJournal.js'
```

```js
// SAU:
import {
  listLedgerEntries,
  getJobById,
  createBackupJob,
  updateJobStatus,
  updateJobProgress,
} from './backupJournal.js'
```

**Bước 2:** Sửa đầu hàm `startRestoreJob()` — tạo job record ngay khi bắt đầu:

```js
// TRƯỚC:
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
```

```js
// SAU:
export async function startRestoreJob({
  sourceJobId,
  sourceDestinationType,
  sourceDestinationConfig = {},
  targetAccountMapping = {},
  options = {},
  logger = console,
}) {
  const { dryRun = false } = options

  const sourceJob = getJobById(sourceJobId)
  if (!sourceJob) throw new Error(`source job not found: ${sourceJobId}`)

  // Tạo job record ngay để có thể track qua /admin/backup/jobs
  const jobRecord = await createBackupJob({
    type: 'restore',
    destinationType: sourceDestinationType || 'local',
    destinationConfig: sourceDestinationConfig,
    accountFilter: Object.values(targetAccountMapping),
    options: { ...options, sourceJobId, targetAccountMapping },
  })
  const restoreId = jobRecord.job_id

  logger.info?.({ restoreId, sourceJobId, dryRun }, 'restore job started')
  await updateJobStatus(restoreId, 'running', { startedAt: Date.now() })
```

**Bước 3:** Cập nhật progress trong vòng lặp restore — thêm `updateJobProgress` call sau mỗi 50 objects (để không quá nhiều writes):

Trong vòng lặp `for (const entry of ledgerEntries)`, sau khi tăng `restored` hoặc `failed`:

```js
// Thêm vào cuối vòng lặp, sau if/else restored/failed block:
    if ((restored + failed) % 50 === 0) {
      await updateJobProgress(restoreId, {
        totalObjects: ledgerEntries.length,
        doneObjects: restored,
        failedObjects: failed,
        totalBytes: 0,
        doneBytes: 0,
      }).catch(() => {})
    }
```

**Bước 4:** Cập nhật trạng thái cuối hàm — thay đoạn `return result` bằng:

```js
// TRƯỚC (cuối hàm):
  const result = {
    restoreId,
    sourceJobId,
    status: failed > 0 ? 'completed_with_errors' : 'completed',
    totalObjects: ledgerEntries.length,
    restoredObjects: restored,
    failedObjects: failed,
    rtdbSynced: restored - rtdbSyncFailures,
    rtdbSyncFailures,
    dryRun,
    errors: errors.slice(0, 50),
  }

  logger.info?.(result, 'restore job finished')
  return result
```

```js
// SAU:
  const finalStatus = failed > 0 ? 'failed' : 'completed'

  await updateJobProgress(restoreId, {
    totalObjects: ledgerEntries.length,
    doneObjects: restored,
    failedObjects: failed,
    totalBytes: 0,
    doneBytes: 0,
  }).catch(() => {})

  await updateJobStatus(restoreId, finalStatus, {
    completedAt: Date.now(),
    lastError: failed > 0 ? `${failed} objects failed` : null,
  })

  const result = {
    restoreId,
    sourceJobId,
    status: failed > 0 ? 'completed_with_errors' : 'completed',
    totalObjects: ledgerEntries.length,
    restoredObjects: restored,
    failedObjects: failed,
    rtdbSynced: restored - rtdbSyncFailures,
    rtdbSyncFailures,
    dryRun,
    errors: errors.slice(0, 50),
  }

  logger.info?.(result, 'restore job finished')
  return result
```

**Bước 5:** Xử lý edge case — nếu `ledgerEntries.length === 0` (early return), phải update job status:

Tìm đoạn early return hiện tại:

```js
// TRƯỚC:
  if (ledgerEntries.length === 0) {
    return {
      restoreId,
      sourceJobId,
      status: 'completed',
      totalObjects: 0,
      ...
    }
  }
```

```js
// SAU:
  if (ledgerEntries.length === 0) {
    await updateJobStatus(restoreId, 'completed', {
      completedAt: Date.now(),
      lastError: null,
    })
    return {
      restoreId,
      sourceJobId,
      status: 'completed',
      totalObjects: 0,
      restoredObjects: 0,
      failedObjects: 0,
      rtdbSynced: 0,
      rtdbSyncFailures: 0,
      dryRun,
      message: 'No completed objects found in source job ledger',
    }
  }
```

**Bước 6:** Bọc toàn bộ logic restore trong try/catch để update status khi có exception:

Sau block `const sourceDest = createDestination(...)`, wrap phần còn lại trong try/catch:

```js
  let restored = 0
  let failed = 0
  // ... (phần khai báo biến giữ nguyên)

  try {
    // ... toàn bộ vòng lặp for (const entry of ledgerEntries) ... giữ nguyên

    // ... options.rebuildRtdb block giữ nguyên

    // Bước 4 ở trên (final updateJobProgress + updateJobStatus + return result) nằm trong try

  } catch (err) {
    logger.error?.({ restoreId, err: err.message }, 'restore job crashed')
    await updateJobStatus(restoreId, 'failed', {
      completedAt: Date.now(),
      lastError: err.message,
    }).catch(() => {})
    throw err
  }
```

### Verify FIX-2

```bash
grep -n "createBackupJob\|updateJobStatus\|updateJobProgress" \
  services/s3proxy/src/backup/restoreManager.js
```

Phải thấy:
- `createBackupJob` (import + call)
- `updateJobStatus` (import + ít nhất 3 calls: running, completed/failed, early return)
- `updateJobProgress` (import + ít nhất 2 calls)

---

## CLEANUP

```bash
cd services/s3proxy

# Full test suite
npm test 2>&1 | tail -30

# Verify grep
echo "=== FIX-1: s3Dest không còn buffer nhỏ ==="
grep -n "Buffer.concat\|chunks = \[\]" src/backup/destinations/s3Dest.js

echo "=== FIX-2: restore ghi DB ==="
grep -n "createBackupJob\|updateJobStatus\|updateJobProgress" src/backup/restoreManager.js
```

---

## BÁO CÁO BẮT BUỘC

Tạo file `docs/SPRINT6_IMPLEMENTATION_REPORT.md`:

```markdown
# Sprint 6 Implementation Report — P1 Improvements
> Ngày: [YYYY-MM-DD] | Agent: [tên model]

## Tóm tắt
[2–3 câu tóm tắt]

## FIX-1: s3Dest streaming

### Thay đổi trong s3Dest.js
- [ ] Đã xóa `chunks = []` + `for await` buffer + `Buffer.concat` trong Path A
- [ ] Đã thêm `Body: stream` trực tiếp vào PutObjectCommand
- [ ] Đã thêm `ContentLength` khi có size
- [ ] Path B (multipart) không thay đổi

- Code Path A sau khi sửa (paste toàn bộ if block):
  ```js
  [paste here]
  ```

### Verify output
```bash
$ grep -n "Buffer.concat\|chunks = \[\]" services/s3proxy/src/backup/destinations/s3Dest.js
[paste output here — chỉ được xuất hiện trong Path B/multipart, không được trong Path A]
```

### Ước tính RAM saving
- Trước: [X]MB peak per concurrent job (tính: concurrency × max_object_size)
- Sau: ~0MB buffer cho objects nhỏ (stream thẳng)

## FIX-2: restoreManager ghi backup_jobs

### Imports đã thêm
- [ ] `createBackupJob` import từ backupJournal
- [ ] `updateJobStatus` import
- [ ] `updateJobProgress` import
- Dòng import sau khi sửa (paste):
  ```js
  [paste here]
  ```

### Job creation
- [ ] `createBackupJob({ type: 'restore', ... })` được gọi ở đầu hàm
- [ ] `restoreId` lấy từ `jobRecord.job_id`
- [ ] `updateJobStatus(restoreId, 'running', ...)` ngay sau tạo job

### Status update cuối
- [ ] `updateJobStatus(restoreId, 'completed'/'failed', ...)` khi xong
- [ ] Early return case (0 entries) cũng update status
- [ ] try/catch wrap + updateJobStatus 'failed' khi crash

### Verify output
```bash
$ grep -n "createBackupJob\|updateJobStatus\|updateJobProgress" \
    services/s3proxy/src/backup/restoreManager.js
[paste output here]
```
- Số lần `updateJobStatus` được gọi: [số] (phải ≥ 3)

## Test results
- Total: [số] | Passed: [số] | Failed: [số]
- Test failures do sprint này gây ra: [có/không]

## So sánh với prompt gốc (Sprint 6)
| Hạng mục trong prompt | Đã làm | Ghi chú |
|---|---|---|
| FIX-1: xóa buffer Path A trong s3Dest | ✅/❌ | |
| FIX-1: Body: stream trực tiếp | ✅/❌ | |
| FIX-1: ContentLength được truyền | ✅/❌ | |
| FIX-1: Path B (multipart) không thay đổi | ✅/❌ | |
| FIX-2: import createBackupJob/updateJobStatus/updateJobProgress | ✅/❌ | |
| FIX-2: tạo job record type='restore' ở đầu hàm | ✅/❌ | |
| FIX-2: updateJobStatus 'running' sau create | ✅/❌ | |
| FIX-2: updateJobProgress trong vòng lặp | ✅/❌ | |
| FIX-2: updateJobStatus cuối (completed/failed) | ✅/❌ | |
| FIX-2: early return case update status | ✅/❌ | |
| FIX-2: try/catch crash → update failed | ✅/❌ | |
| npm test pass | ✅/❌ | |

## Vấn đề gặp phải
[...]

## Vấn đề phát hiện thêm (KHÔNG fix trong sprint này)
[...]

## Deviation so với prompt (nếu có)
[...]
```

---

**NHẮC NHỞ CUỐI:**

```bash
# Chạy tất cả verify commands và paste output thực tế vào report:

grep -n "Buffer.concat\|chunks = \[\]" services/s3proxy/src/backup/destinations/s3Dest.js

grep -n "createBackupJob\|updateJobStatus\|updateJobProgress" \
  services/s3proxy/src/backup/restoreManager.js

cd services/s3proxy && npm test 2>&1 | grep -E "passing|failing"
```

Không fake kết quả. Nếu test fail do code của sprint này, phải fix trước khi submit.
