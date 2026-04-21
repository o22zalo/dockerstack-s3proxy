# Sprint 3 Implementation Report — P2 Bugs + Performance
> Ngày: 2026-04-21 | Agent: GPT-5.3-Codex

## Tóm tắt
Đã triển khai BUG-7, BUG-8, BUG-9 và PERF-1~4 theo thứ tự yêu cầu trong prompt Sprint 3, gồm sửa fallback GDrive, guard khi backup disabled, batch ledger upsert, throttle progress flush, bổ sung indexes và metrics migration.

## BUG-7: GDrive read sau restart

- [x] `GDriveDestination.extractFileId(dstLocation)` static method
- [x] `_findFileIdByDescription(key)` helper method
- [x] `read()` fallback chain: memory → dstLocation → GDrive search
- [x] `exists()` fallback tương tự
- [x] `restoreManager.js` pass `dstLocation` khi gọi `read()`
- Unit test kết quả:
  ```
  extractFileId test: PASS file456
  ```

## BUG-8: API path documentation

- [x] `docs/BACKUP_API_REFERENCE.md` đã tạo
- Số endpoints được document: 23
- Có đề cập path prefix `/admin/backup/` (không có `/api/`): yes

## BUG-9: BACKUP_ENABLED guard

- [x] Guard added trong backupRoutes
- [x] `/admin/backup/config` vẫn accessible khi BACKUP_ENABLED=false
- [x] Các endpoint backup khác trả 503 khi disabled

## PERF-1: Batch ledger upsert

- [x] `batchUpsertLedgerEntries` transaction added trong backupJournal.js
- [x] Import trong backupManager.js
- [x] Upsert calls trong vòng lặp scan đã được batch theo page
- [x] Duplicate upsert calls đã được xóa trong task copy path
- Ước tính improvement: 1 transaction/page thay cho N transactions/page

## PERF-2: Composite index

- [x] `idx_backup_ledger_job_status_id` đã thêm vào db.js
- [x] `idx_backend_migrations_created` đã thêm

## PERF-3: Progress throttle

- [x] `flushProgressIfNeeded()` helper function
- [x] `PROGRESS_FLUSH_INTERVAL_MS = 3000`
- [x] Replaced `updateJobProgress` calls trong vòng lặp
- [x] Force flush ở các điểm quan trọng

## PERF-4: migrationObjectsTotal metric

- [x] Import metrics trong backendReplacer.js
- [x] Increment sau done
- [x] Increment sau failed

## Verify commands output
```bash
$ grep -n "extractFileId\|_findFileIdByDescription\|dstLocation" services/s3proxy/src/backup/destinations/gdriveDest.js
15:  static extractFileId(dstLocation) {
84:  async _findFileIdByDescription(key) {
109:  async read(key, { dstLocation = null } = {}) {
...

$ grep -n "BACKUP_DISABLED\|BACKUP_ENABLED" services/s3proxy/src/routes/backup.js
52:    if (config.BACKUP_ENABLED) return
60:      error: 'BACKUP_DISABLED',

$ grep -n "batchUpsertLedgerEntries\|db.transaction" services/s3proxy/src/backup/backupJournal.js
246:export const batchUpsertLedgerEntries = db.transaction((entries = []) => {

$ grep -n "idx_backup_ledger_job_status_id\|idx_backend_migrations_created" services/s3proxy/src/db.js
324:  CREATE INDEX IF NOT EXISTS idx_backup_ledger_job_status_id ON backup_ledger(job_id, status, id);
326:  CREATE INDEX IF NOT EXISTS idx_backend_migrations_created ON backend_migrations(created_at DESC);

$ grep -n "flushProgressIfNeeded\|PROGRESS_FLUSH_INTERVAL" services/s3proxy/src/backup/backupManager.js
219:  const PROGRESS_FLUSH_INTERVAL_MS = 3000
220:  const flushProgressIfNeeded = async (force = false) => {
...

$ grep -n "migrationObjectsTotal" services/s3proxy/src/backup/backendReplacer.js
181:        metrics.migrationObjectsTotal.inc({
257:      metrics.migrationObjectsTotal.inc({
```

## Test results
- `npm test` (services/s3proxy): có 1 case fail ở T6 liên quan auth cron endpoint (`POST /api/cron-jobs/:jobId/run without auth`).

## So sánh với prompt gốc (Sprint 3)
| Hạng mục | Đã làm | Ghi chú |
|---|---|---|
| BUG-7 | ✅ | Fallback đầy đủ + restore pass dstLocation |
| BUG-8 | ✅ | Tạo `docs/BACKUP_API_REFERENCE.md` |
| BUG-9 | ✅ | Guard trả 503 khi backup disabled |
| PERF-1 | ✅ | Batch transaction theo page |
| PERF-2 | ✅ | Thêm 2 index mới |
| PERF-3 | ✅ | Throttle flush progress 3s |
| PERF-4 | ✅ | Ghi metrics done/failed |
