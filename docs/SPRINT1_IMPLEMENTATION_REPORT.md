# Sprint 1 Implementation Report — P0 Bug Fixes
> Ngày: 2026-04-21 | Agent: GPT-5.3-Codex

## Tóm tắt
Đã hoàn thành fix BUG-1 (streaming thay vì buffer RAM) cho `restoreManager.js` và `backendReplacer.js`, đồng thời thêm cache S3 client cho restore để tránh tạo client lặp.  
Đã fix BUG-2 bằng cách ghi/đọc thực tế bảng `backend_migrations`, cập nhật rollback thực cho `replace_config`, và sửa endpoint list migrations để đọc dữ liệu DB thật.  
Đã fix BUG-3 cho luồng ZIP download bằng cơ chế auto outputPath + lưu path vào DB + finalize zip + stream file từ disk qua endpoint download.

## BUG-1: RAM buffer → Streaming

### restoreManager.js
- [x] Đã xóa pattern `chunks.push` + `Buffer.concat`
- [x] Đã thay bằng streaming `Body: readStream`
- [x] Đã thêm `ContentLength` khi có sizeBytes
- [x] Đã tạo `clientCache` để reuse S3Client
- Diff ngắn gọn (5-10 dòng quan trọng nhất):
  ```diff
  +const clientCache = new Map()
  +const getOrCreateClient = (account) => { ... }
  -const chunks = []
  -for await (const chunk of readStream) { chunks.push(...) }
  -const body = Buffer.concat(chunks)
  +const client = getOrCreateClient(targetAccount)
   await client.send(new PutObjectCommand({
  -  Body: body,
  +  Body: readStream,
  +  ContentLength: sizeBytes > 0 ? sizeBytes : undefined,
   }))
  ```

### backendReplacer.js
- [x] Đã thêm `HeadObjectCommand` để lấy size trước khi stream
- [x] Đã xóa pattern `chunks.push` + `Buffer.concat`
- [x] Đã thay bằng streaming `Body: getRes.Body`
- Diff ngắn gọn:
  ```diff
  +const headRes = await sourceClient.send(new HeadObjectCommand(...))
  +const objectSize = Number(headRes.ContentLength || 0)
  +const contentType = headRes.ContentType || 'application/octet-stream'
  -const chunks = []
  -for await (const chunk of getRes.Body) chunks.push(...)
  -const body = Buffer.concat(chunks)
   await targetClient.send(new PutObjectCommand({
  -  Body: body,
  -  ContentType: getRes.ContentType || 'application/octet-stream',
  +  Body: getRes.Body,
  +  ContentType: contentType,
  +  ContentLength: objectSize > 0 ? objectSize : undefined,
   }))
  ```

### Verify result
- grep `Buffer.concat` trong backup/ còn không: còn, nhưng chỉ ở destination known-issue/expected.
- Remaining occurrences (nếu có):
  - `services/s3proxy/src/backup/destinations/onedriveDest.js:50` — known issue P3 theo prompt.
  - `services/s3proxy/src/backup/destinations/s3Dest.js:45,69` — multipart/chunk combine nội bộ destination.

## BUG-2: backend_migrations không ghi DB

### Các thay đổi
- [x] Đã import `db` từ `../db.js` trong backendReplacer.js
- [x] Đã thêm `stmts` object với 4 prepared statements
- [x] `replaceBackendConfig()` INSERT + UPDATE backend_migrations
- [x] `migrateBackendObjects()` INSERT + UPDATE backend_migrations
- [x] `rollbackMigration()` thực sự đọc DB và rollback replace_config
- [x] Export `listMigrationsFromDb()` từ backendReplacer.js
- [x] routes/backup.js sử dụng `listMigrationsFromDb()` thay vì hardcoded `[]`

### Verify result
- `GET /admin/backup/backends/migrations` sau khi chạy 1 migration: chưa gọi HTTP trực tiếp trong report này, nhưng cùng nguồn dữ liệu đã được verify qua `listMigrationsFromDb()` trả về record mới tạo.
- DB query: `SELECT * FROM backend_migrations LIMIT 3;`
  - Kết quả thực tế:
    ```
    mig_65fd0127-5e50-4d65-8b04-f3dc02365028|replace_config|completed|test-acc|test-acc
    ```

## BUG-3: ZIP download endpoint

### Các thay đổi
- [x] `startBackupJob()` detect zip + set `_autoAssignOutputPath`
- [x] `processBackupJob()` resolve outputPath trước khi tạo ZipDestination
- [x] `setJobOutputPath()` thêm vào backupJournal.js
- [x] outputPath được lưu vào `options_json` trong DB
- [x] ZipDestination `finalize()` được gọi sau khi job xong
- [x] Download endpoint đọc outputPath từ options_json và stream file
- [x] Import `createReadStream`, `existsSync`, `pipeline` đã có trong routes/backup.js

### Verify result
- ZIP job created với jobId: chưa verify end-to-end trong môi trường này.
- outputPath trong DB: chưa verify end-to-end bằng zip job thực.
- File tồn tại trên disk: chưa verify.
- `unzip -l backup.zip` output: chưa verify.
- Lý do: môi trường đang chặn cài package từ npm registry (`403 Forbidden`), nên không thể bảo đảm runtime `archiver` để chạy zip flow thực tế trong container hiện tại.

## Test results
- Total tests: 58
- Passed: 57
- Failed: 1
- Failures do thay đổi của sprint này: không; failure thuộc test cron API hiện hữu (`POST /api/cron-jobs/:jobId/run without auth` nhận 200 thay vì kỳ vọng khác).

## So sánh với prompt gốc (Sprint 1)
| Hạng mục trong prompt | Đã làm | Ghi chú |
|---|---|---|
| BUG-1a: restoreManager stream | ✅ | Đã stream trực tiếp + ContentLength + clientCache |
| BUG-1b: backendReplacer stream | ✅ | Đã dùng HeadObject + stream Body |
| BUG-1 verify grep | ✅ | Chỉ còn occurrences ở s3Dest/onedriveDest |
| BUG-2a: import db | ✅ | |
| BUG-2b: replaceBackendConfig INSERT/UPDATE | ✅ | |
| BUG-2c: migrateBackendObjects INSERT/UPDATE | ✅ | Có thêm fail-safe update khi throw |
| BUG-2d: rollbackMigration đọc DB | ✅ | Rollback thực cho replace_config |
| BUG-2e: listMigrations endpoint | ✅ | Đọc DB thật qua listMigrationsFromDb |
| BUG-3: auto outputPath cho zip | ✅ | |
| BUG-3: setJobOutputPath journal | ✅ | |
| BUG-3: finalize() sau job xong | ✅ | |
| BUG-3: download endpoint stream file | ✅ | |
| Cleanup: npm test | ✅ | Có 1 test fail sẵn không thuộc scope sprint |

## Vấn đề gặp phải và cách xử lý
- Môi trường chặn npm registry (`npm install archiver@^7` trả `403 Forbidden`).
- Để vẫn đảm bảo luồng không-zip chạy/test được, giữ approach load runtime phù hợp và tập trung verify logic P0 qua static check + test suite sẵn có.
- Failure cron API trong `npm test` không thuộc file/luồng backup sprint này nên chỉ ghi nhận.

## Thay đổi không có trong prompt (nếu có)
- Thêm fail-safe `try/catch` bao phần migrate concurrency để đảm bảo luôn update trạng thái migration = `failed` trước khi throw lỗi ra ngoài (đúng tinh thần prompt "Quan trọng" phần BUG-2c).
