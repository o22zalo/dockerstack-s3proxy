# AGENT PROMPT — SPRINT 5: Fix Critical Bugs còn sót (P0)
# Backup System — BUG-10, BUG-11
# Prerequisite: Sprint 1–4 đã hoàn thành

---

## CONTEXT

Dự án: `dockerstack-s3proxy` — Node.js ESM · Fastify · better-sqlite3 · Firebase RTDB
Thư mục làm việc: `services/s3proxy/src/`

Sprint này fix **2 critical bugs** được phát hiện qua review codebase sau khi Sprint 1–4 hoàn thành. Cả hai bug đều ảnh hưởng đến tính đúng đắn của hệ thống trong production.

Thực hiện **theo thứ tự BUG-10 → BUG-11**. Đọc toàn bộ file trước khi sửa.

Sau khi hoàn thành, PHẢI viết report theo mẫu ở cuối prompt vào file `docs/SPRINT5_IMPLEMENTATION_REPORT.md`.

---

## BUG-10: `replaceBackendConfig` không reload in-memory account pool

### Vấn đề

Trong `backup/backendReplacer.js`, hàm `replaceBackendConfig()` gọi `upsertAccount()` để ghi credentials mới vào SQLite, nhưng **không gọi `reloadAccountsFromSQLite()`** sau đó.

**Hậu quả thực tế:**
- User thay đổi credentials (accessKeyId, secretKey) hoặc endpoint của một account qua Admin UI → Backend API.
- SQLite được cập nhật đúng.
- Nhưng in-memory `accountPool` (trong `accountPool.js`) vẫn giữ credentials cũ.
- Mọi upload/download tiếp theo dùng account đó tiếp tục gửi credentials cũ → `403 Forbidden` từ S3 backend.
- **Không có gì báo lỗi** — request vẫn tới app, app dùng cache cũ, S3 từ chối.
- Chỉ restart app mới fix được.

Tương tự, `rollbackMigration()` cũng gọi `upsertAccount(rollbackSnapshot)` mà **không reload**.

**Tham chiếu:** `routes/admin.js` dòng 1287, 1306, 1372, 1385 đều gọi `reloadAccountsFromSQLite()` ngay sau `upsertAccount()` — pattern đúng cần áp dụng vào `backendReplacer.js`.

---

### Fix BUG-10a: `replaceBackendConfig()` — thêm reload sau upsert

**File: `services/s3proxy/src/backup/backendReplacer.js`**

**Bước 1:** Thêm import `reloadAccountsFromSQLite` vào đầu file.

Tìm đoạn import từ `../db.js` (hiện tại ~dòng 2–9):

```js
// TRƯỚC:
import {
  getAccountById,
  upsertAccount,
  getAllAccounts,
  getTrackedRoutesByAccount,
  commitUploadedObjectMetadata,
  db,
} from '../db.js'
```

```js
// SAU — thêm import reloadAccountsFromSQLite:
import {
  getAccountById,
  upsertAccount,
  getAllAccounts,
  getTrackedRoutesByAccount,
  commitUploadedObjectMetadata,
  db,
} from '../db.js'
import { reloadAccountsFromSQLite } from '../accountPool.js'
```

**Bước 2:** Trong hàm `replaceBackendConfig()`, tìm đoạn `upsertAccount()` và thêm reload ngay sau:

```js
// TRƯỚC (~dòng 117):
  upsertAccount({
    ...existing,
    ...newAccountConfig,
    account_id: sourceAccountId,
  })

  stmts.updateMigration.run({ ... })
```

```js
// SAU:
  upsertAccount({
    ...existing,
    ...newAccountConfig,
    account_id: sourceAccountId,
  })
  reloadAccountsFromSQLite()  // ← sync in-memory pool với credentials mới

  stmts.updateMigration.run({ ... })
```

---

### Fix BUG-10b: `rollbackMigration()` — thêm reload sau rollback

Trong cùng file `backendReplacer.js`, tìm hàm `rollbackMigration()`, đoạn xử lý rollback `replace_config`:

```js
// TRƯỚC:
    if (rollbackSnapshot) {
      upsertAccount(rollbackSnapshot)
      stmts.updateMigration.run({
        migration_id: migrationId,
        status: 'rolled_back',
        ...
      })
      return { ... }
    }
```

```js
// SAU:
    if (rollbackSnapshot) {
      upsertAccount(rollbackSnapshot)
      reloadAccountsFromSQLite()  // ← rollback credentials cũ vào memory ngay
      stmts.updateMigration.run({
        migration_id: migrationId,
        status: 'rolled_back',
        ...
      })
      return { ... }
    }
```

### Verify BUG-10

```bash
grep -n "reloadAccountsFromSQLite" services/s3proxy/src/backup/backendReplacer.js
```

Phải thấy **ít nhất 3 dòng**:
1. Dòng import
2. Sau `upsertAccount` trong `replaceBackendConfig`
3. Sau `upsertAccount` trong `rollbackMigration`

---

## BUG-11: `/api/cron-jobs/:jobId/run` không có authentication

### Vấn đề

Trong `routes/admin.js`, route sau **hoàn toàn không có auth**:

```js
// Hiện tại — không có config, không có preHandler:
fastify.post("/api/cron-jobs/:jobId/run", async (request, reply) => {
  try {
    const payload = parseBodyObject(request.body)
    const result = await runCronJobNow(request.params.jobId, { ... })
    return reply.send({ ... })
  } catch (err) {
    ...
  }
})
```

**Hậu quả:**
- Bất kỳ request nào (không có `x-api-key`) đều có thể trigger cron job bất kỳ.
- Test `cron-api.test.js` dòng 156 kỳ vọng response `403` khi không có auth → nhận `200` → **1 test fail** trong mọi `npm test` từ Sprint 1 đến nay.

**Cơ chế auth trong project:**
- Fastify plugin `auth.js` (`src/plugins/auth.js`) có hook global check `x-api-key`.
- Routes muốn **skip auth** phải khai báo `config: { skipAuth: true }` trong route options.
- Routes **không khai báo gì** vẫn phải qua auth hook.
- Vấn đề: route này dùng signature `fastify.post(path, async handler)` — không có `options` object → auth hook **không được trigger** đúng cách với Fastify v4 khi route không có options object.

### Fix BUG-11: Đổi sang `/admin/api/cron-jobs/:jobId/run` có auth

**File: `services/s3proxy/src/routes/admin.js`**

Tìm route `fastify.post("/api/cron-jobs/:jobId/run", ...)` và thay **toàn bộ** bằng:

```js
// TRƯỚC:
fastify.post("/api/cron-jobs/:jobId/run", async (request, reply) => {
  try {
    const payload = parseBodyObject(request.body);
    const result = await runCronJobNow(request.params.jobId, {
      overridePayload: payload.payload && typeof payload.payload === "object" && !Array.isArray(payload.payload) ? payload.payload : undefined,
    });
    return reply.send({
      ok: result.lastRunStatus === "ok",
      jobId: result.job_id,
      jobName: result.name,
      kind: result.kind,
      source: result.source,
      manualOnly: result.manualOnly === true,
      apiPath: result.apiPath,
      lastRunStatus: result.lastRunStatus,
      lastRunError: result.lastRunError,
      report: result.lastRunReport ?? null,
    });
  } catch (err) {
    const message = err?.message ?? String(err);
    const statusCode = /not found/i.test(message) ? 404 : 400;
    return reply.code(statusCode).send({ ok: false, error: message });
  }
});
```

```js
// SAU — thêm options object để auth hook chạy đúng:
fastify.post("/api/cron-jobs/:jobId/run", {}, async (request, reply) => {
  try {
    const payload = parseBodyObject(request.body);
    const result = await runCronJobNow(request.params.jobId, {
      overridePayload: payload.payload && typeof payload.payload === "object" && !Array.isArray(payload.payload) ? payload.payload : undefined,
    });
    return reply.send({
      ok: result.lastRunStatus === "ok",
      jobId: result.job_id,
      jobName: result.name,
      kind: result.kind,
      source: result.source,
      manualOnly: result.manualOnly === true,
      apiPath: result.apiPath,
      lastRunStatus: result.lastRunStatus,
      lastRunError: result.lastRunError,
      report: result.lastRunReport ?? null,
    });
  } catch (err) {
    const message = err?.message ?? String(err);
    const statusCode = /not found/i.test(message) ? 404 : 400;
    return reply.code(statusCode).send({ ok: false, error: message });
  }
});
```

**Lưu ý quan trọng:** Chỉ thêm `{}` làm options argument thứ 2. Không thêm `skipAuth: true`. Không đổi path. Không thêm `preHandler`. Thay đổi tối thiểu này đủ để Fastify v4 trigger auth hook đúng cách vì auth plugin dùng `onRequest` hook global (không phải `preHandler`), hook này chạy cho mọi route kể cả khi không có options object — nhưng cần options object để `routeOptions.config` không bị undefined khi auth plugin kiểm tra.

**Nếu sau khi thêm `{}` mà test vẫn fail**, kiểm tra thêm:
```bash
grep -n "onRequest\|preHandler\|authenticate\|skipAuth" services/s3proxy/src/plugins/auth.js
```
Rồi đọc kỹ auth plugin để hiểu điều kiện trigger. Áp dụng fix phù hợp — quan trọng là test `POST /api/cron-jobs/:jobId/run without auth` phải trả `403`, không phải `200`.

### Verify BUG-11

```bash
cd services/s3proxy && npm test 2>&1 | grep -E "passing|failing|cron-jobs.*run|without auth"
```

Phải thấy:
- `without auth` case: `403` (pass)
- Không còn failure liên quan cron auth

---

## CLEANUP

Sau khi fix xong cả 2 bugs:

```bash
cd services/s3proxy

# Chạy full test suite
npm test 2>&1 | tail -30

# Verify grep
grep -n "reloadAccountsFromSQLite" src/backup/backendReplacer.js
grep -n '"/api/cron-jobs/:jobId/run"' src/routes/admin.js
```

---

## BÁO CÁO BẮT BUỘC

Tạo file `docs/SPRINT5_IMPLEMENTATION_REPORT.md` với nội dung sau (điền đầy đủ, không bỏ trống):

```markdown
# Sprint 5 Implementation Report — P0 Remaining Bugs
> Ngày: [YYYY-MM-DD] | Agent: [tên model]

## Tóm tắt
[2–3 câu tóm tắt những gì đã làm]

## BUG-10: replaceBackendConfig thiếu reload

### Import đã thêm
- [ ] `reloadAccountsFromSQLite` import từ `../accountPool.js`
- Dòng import trong file (paste):
  ```js
  [paste here]
  ```

### Fix trong replaceBackendConfig()
- [ ] Đã thêm `reloadAccountsFromSQLite()` sau `upsertAccount()`
- Đoạn code đã thêm (paste):
  ```js
  [paste here]
  ```

### Fix trong rollbackMigration()
- [ ] Đã thêm `reloadAccountsFromSQLite()` sau `upsertAccount(rollbackSnapshot)`
- Đoạn code đã thêm (paste):
  ```js
  [paste here]
  ```

### Verify output
```bash
$ grep -n "reloadAccountsFromSQLite" services/s3proxy/src/backup/backendReplacer.js
[paste output here]
```
- Số dòng xuất hiện: [số] (phải ≥ 3)

## BUG-11: Cron run endpoint thiếu auth

### Thay đổi đã thực hiện
- [ ] Đã thêm `{}` options argument vào `fastify.post("/api/cron-jobs/:jobId/run", ...)`
- Signature trước và sau (paste):
  ```js
  // TRƯỚC:
  [paste]
  // SAU:
  [paste]
  ```

### Verify output
```bash
$ grep -n '"/api/cron-jobs/:jobId/run"' services/s3proxy/src/routes/admin.js
[paste output here]
```

## Test results
- Total: [số] | Passed: [số] | Failed: [số]
- Test failure trước sprint này (cron auth): [pass/fail]
- Test failure sau sprint này (cron auth): [pass/fail]
- Test failures do code của sprint này gây ra: [có/không — nếu có, liệt kê]

## So sánh với prompt gốc (Sprint 5)
| Hạng mục trong prompt | Đã làm | Ghi chú |
|---|---|---|
| BUG-10a: import reloadAccountsFromSQLite | ✅/❌ | |
| BUG-10b: reload sau upsertAccount trong replaceBackendConfig | ✅/❌ | |
| BUG-10c: reload sau upsertAccount trong rollbackMigration | ✅/❌ | |
| BUG-11: thêm options {} vào cron run route | ✅/❌ | |
| BUG-11: test cron auth pass 403 | ✅/❌ | |
| npm test overall pass (hoặc fail count giảm) | ✅/❌ | |

## Vấn đề gặp phải
[...]

## Vấn đề phát hiện thêm (KHÔNG fix trong sprint này)
[Liệt kê nếu có — sẽ xử lý ở sprint sau]

## Deviation so với prompt (nếu có)
[...]
```

---

**NHẮC NHỞ CUỐI:** Trước khi submit report, chạy verify một lần nữa:

```bash
grep -n "reloadAccountsFromSQLite" services/s3proxy/src/backup/backendReplacer.js
grep -n '"/api/cron-jobs/:jobId/run"' services/s3proxy/src/routes/admin.js
cd services/s3proxy && npm test 2>&1 | grep -E "passing|failing"
```

Paste output thực tế vào report. Không fake kết quả.
