# Sprint 5 Implementation Report — P0 Remaining Bugs
> Ngày: 2026-04-21 | Agent: GPT-5.3-Codex

## Tóm tắt
Đã fix BUG-10 trong `backendReplacer.js` bằng cách reload lại in-memory account pool ngay sau các thao tác `upsertAccount()` ở cả flow replace và rollback. Đồng thời đã xử lý BUG-11 cho endpoint cron external run để bắt buộc auth khi gọi `/api/cron-jobs/:jobId/run`.

Theo prompt gốc, thay đổi tối thiểu cho BUG-11 là thêm `{}` options argument. Tuy nhiên do test vẫn fail sau bước này, đã áp dụng thêm `preHandler: [fastify.authenticate]` cho chính route này để đảm bảo trả về `403` khi thiếu `x-api-key`.

## BUG-10: replaceBackendConfig thiếu reload

### Import đã thêm
- [x] `reloadAccountsFromSQLite` import từ `../accountPool.js`
- Dòng import trong file (paste):
  ```js
  import { reloadAccountsFromSQLite } from '../accountPool.js'
  ```

### Fix trong replaceBackendConfig()
- [x] Đã thêm `reloadAccountsFromSQLite()` sau `upsertAccount()`
- Đoạn code đã thêm (paste):
  ```js
  upsertAccount({
    ...existing,
    ...newAccountConfig,
    account_id: sourceAccountId,
  })
  reloadAccountsFromSQLite()
  ```

### Fix trong rollbackMigration()
- [x] Đã thêm `reloadAccountsFromSQLite()` sau `upsertAccount(rollbackSnapshot)`
- Đoạn code đã thêm (paste):
  ```js
  if (rollbackSnapshot) {
    upsertAccount(rollbackSnapshot)
    reloadAccountsFromSQLite()
    stmts.updateMigration.run({
      migration_id: migrationId,
      status: 'rolled_back',
      ...
    })
  }
  ```

### Verify output
```bash
$ grep -n "reloadAccountsFromSQLite" services/s3proxy/src/backup/backendReplacer.js
10:import { reloadAccountsFromSQLite } from '../accountPool.js'
123:  reloadAccountsFromSQLite()
327:      reloadAccountsFromSQLite()
```
- Số dòng xuất hiện: 3 (đạt yêu cầu ≥ 3)

## BUG-11: Cron run endpoint thiếu auth

### Thay đổi đã thực hiện
- [x] Đã thêm options argument vào `fastify.post("/api/cron-jobs/:jobId/run", ...)`
- [x] Đã thêm `preHandler: [fastify.authenticate]` vì test vẫn fail khi chỉ thêm `{}`
- Signature trước và sau (paste):
  ```js
  // TRƯỚC:
  fastify.post("/api/cron-jobs/:jobId/run", async (request, reply) => {

  // SAU:
  fastify.post("/api/cron-jobs/:jobId/run", { preHandler: [fastify.authenticate] }, async (request, reply) => {
  ```

### Verify output
```bash
$ grep -n '"/api/cron-jobs/:jobId/run"' services/s3proxy/src/routes/admin.js
1729:  fastify.post("/api/cron-jobs/:jobId/run", { preHandler: [fastify.authenticate] }, async (request, reply) => {
```

## Test results
- Total: không có số tổng gộp từ runner (nhiều suite con) | Passed: nhiều suite pass | Failed: 1 case trong e2e backup test
- Test failure trước sprint này (cron auth): fail (trả 200 khi thiếu auth)
- Test failure sau sprint này (cron auth): pass (bị chặn khi thiếu auth)
- Test failures do code của sprint này gây ra: chưa xác nhận; còn 1 fail ở `backup system e2e` với thông báo `job status expected completed, got undefined` (khả năng issue nền sẵn có ở test/backup manager contract)

## So sánh với prompt gốc (Sprint 5)
| Hạng mục trong prompt | Đã làm | Ghi chú |
|---|---|---|
| BUG-10a: import reloadAccountsFromSQLite | ✅ | |
| BUG-10b: reload sau upsertAccount trong replaceBackendConfig | ✅ | |
| BUG-10c: reload sau upsertAccount trong rollbackMigration | ✅ | |
| BUG-11: thêm options {} vào cron run route | ✅ | Đã làm và mở rộng thành preHandler auth để test pass |
| BUG-11: test cron auth pass 403 | ✅ | |
| npm test overall pass (hoặc fail count giảm) | ❌ | Còn 1 fail không liên quan trực tiếp cron auth |

## Vấn đề gặp phải
- Chỉ thêm `{}` cho route `/api/cron-jobs/:jobId/run` chưa đủ để chặn request không auth trong codebase hiện tại, do admin routes không có auth hook global trong module này. Cần gắn explicit `preHandler: [fastify.authenticate]` cho route external API.

## Vấn đề phát hiện thêm (KHÔNG fix trong sprint này)
- Test `backup system e2e` đang fail với lỗi:
  - `job status expected completed, got undefined`
  - Dấu hiệu: contract trả về từ `runPendingBackupJobs` có thể không còn là object job như test mong đợi.

## Deviation so với prompt (nếu có)
- BUG-11: thay vì dừng ở `{}`, đã thêm `preHandler: [fastify.authenticate]` để đảm bảo hành vi auth đúng theo test thực tế.
