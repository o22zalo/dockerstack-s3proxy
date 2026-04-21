# Backup System Implementation Report (v1)

## 1) Trạng thái steps theo `docs/BACKUP_SYSTEM_PLAN.md`

| Step | Trạng thái | Ghi chú |
|---|---|---|
| Env mới (`BACKUP_*`) | ✅ Xong | Đã thêm vào `.env.example`, `src/config.js`, `compose.apps.yml`. |
| SQLite tables `backup_jobs`, `backup_ledger` | ✅ Xong (MVP) | Đã thêm schema + index cần thiết trong `src/db.js`. |
| Backup RTDB riêng | ✅ Xong (MVP) | Đã thêm helper `backupFirebase.js`, đồng bộ trạng thái job/progress khi có `BACKUP_RTDB_URL`. |
| Backup manager / journal / worker | ✅ Xong (MVP) | Có đủ `backupJournal.js`, `backupManager.js`, `backupWorker.js`. |
| Destination adapters | ✅ Xong (MVP) | Hỗ trợ `local` và `mock` + factory `destinations/index.js`. |
| API route backup | ✅ Xong (MVP) | `GET/POST /admin/backup/jobs`, `GET /admin/backup/jobs/:jobId`, `POST cancel`. |
| Container riêng cho backup | ✅ Xong | `backup-worker` service + trigger bằng `BACKUP_SYSTEM_ENABLE=true|false`. |
| Restore / backend replacer đầy đủ | ⏳ Chưa làm | Chưa triển khai `restoreManager.js`, `backendReplacer.js`, migration ledger. |
| UI tab backup trực tiếp trong admin-ui | ⏳ Chưa làm | Hiện tại thao tác bằng API `/admin/backup/*` (hướng dẫn ở mục deploy/UI). |

## 2) Danh sách file ảnh hưởng và tác dụng

### File mới

- `services/s3proxy/src/backup/backupFirebase.js`: client RTDB riêng cho backup state.
- `services/s3proxy/src/backup/backupJournal.js`: lưu/đọc job + ledger + sync progress/status.
- `services/s3proxy/src/backup/backupManager.js`: tạo job, chạy queue, cancel, xử lý concurrency.
- `services/s3proxy/src/backup/backupWorker.js`: copy object từ backend S3 sang destination.
- `services/s3proxy/src/backup/destinations/index.js`: factory destination.
- `services/s3proxy/src/backup/destinations/localDest.js`: lưu object backup ra local volume.
- `services/s3proxy/src/backup/destinations/mockDest.js`: đẩy object sang mock HTTP server.
- `services/s3proxy/src/routes/backup.js`: HTTP API điều khiển backup jobs.
- `services/s3proxy/src/backupRunner.js`: worker process chạy trong container riêng.
- `services/s3proxy/test/backup-system.test.js`: test mock server e2e cho backup flow.

### File chỉnh sửa

- `.env.example`: biến cấu hình backup mới + `BACKUP_SYSTEM_ENABLE`.
- `compose.apps.yml`: inject env backup cho app + thêm service `backup-worker`.
- `docker-compose/scripts/dc.sh`: tự bật profile `backup-worker` khi `BACKUP_SYSTEM_ENABLE=true`.
- `services/s3proxy/src/config.js`: parse config backup.
- `services/s3proxy/src/db.js`: thêm bảng/index backup.
- `services/s3proxy/src/index.js`: register backup routes.
- `services/s3proxy/package.json`: thêm `backup-system.test.js` vào test suite.

## 3) Nguyên tắc kiểm thử (syntax/logic/mock server)

### Syntax / static checks

- Chạy toàn bộ test hiện có để đảm bảo không phá logic cũ.
- Chạy test mới cho backup flow với mock server để xác minh stream/copy/progress.

### Logic checks chính

- Job tạo mới vào `backup_jobs` phải ở trạng thái `pending`.
- Worker lấy job `pending` đầu tiên, chuyển `running`, cập nhật progress.
- Mỗi object route active tạo một ledger record.
- Upload thành công → ledger `done`; upload lỗi retry 3 lần → ledger `failed`.
- Job hoàn tất toàn bộ object thành công → `completed`; có lỗi → `failed`.

### Mock server kiểm thử

- Fake S3 server: trả về `HEAD` và `GET` object để worker đọc stream.
- Fake destination HTTP server: nhận `PUT /upload/:key`, lưu body nhận được.
- Assert payload object tại destination khớp object source.

## 4) Điểm cần chú ý để deploy + hướng dẫn UI/API

### Biến môi trường bắt buộc cho backup

- `BACKUP_SYSTEM_ENABLE=true` để bật container worker riêng.
- `S3PROXY_BACKUP_ENABLED=false` cho container app chính (khuyến nghị), vì worker chạy riêng.
- `S3PROXY_BACKUP_RTDB_URL=<firebase backup url>` nếu muốn sync state ra Firebase riêng.

### Luồng deploy

1. Cập nhật `.env` theo biến mới.
2. `npm run dockerapp-exec:up` (hoặc `dockerapp-exec:restart`).
3. Kiểm tra service `backup-worker` đã chạy khi `BACKUP_SYSTEM_ENABLE=true`.
4. Gọi API quản trị backup qua `/admin/backup/jobs` (đi qua auth hiện tại của admin).

### Hướng dẫn thao tác (UI/API hiện tại)

- Tạo job backup:
```bash
curl -X POST "$BASE/admin/backup/jobs" \
  -H "x-api-key: $S3PROXY_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "type":"full",
    "destinationType":"local",
    "destinationConfig":{"rootDir":"/backup-data"},
    "accountFilter":[],
    "options":{"skipExistingByEtag":true}
  }'
```
- Xem danh sách jobs: `GET /admin/backup/jobs`
- Xem chi tiết 1 job: `GET /admin/backup/jobs/:jobId`
- Hủy job: `POST /admin/backup/jobs/:jobId/cancel`

> Ghi chú: hiện chưa thêm tab backup trực tiếp trong `admin-ui.html`; thao tác bằng API và có thể tích hợp nhanh thành tab ở vòng sau.

## 5) Flow diagram chi tiết

```mermaid
flowchart TD
  A[Start: POST /admin/backup/jobs] --> B[backupJournal.createBackupJob]
  B --> C[(SQLite backup_jobs = pending)]
  C --> D[(Backup RTDB status pending)]
  D --> E[backup-worker container polling runPendingBackupJobs]
  E --> F[set status running + load active routes/accounts]
  F --> G{Có nhiều destination?}
  G -- Không --> H1[createDestination 1 adapter]
  G -- Có --> H2[create nhiều adapters theo destinationConfig.destinations[]]
  H1 --> I[Loop từng object route active]
  H2 --> I
  I --> J[backupWorker HEAD + GET object từ S3 backend]
  J --> K[upload stream tới từng destination]
  K --> L[update backup_ledger + progress]
  L --> M{còn object?}
  M -- Có --> I
  M -- Không --> N{failedObjects > 0?}
  N -- Không --> O[status completed]
  N -- Có --> P[status failed]
  O --> Q[(Sync Backup RTDB progress/status)]
  P --> Q
```

## 6) Log mong muốn

### Log khi thành công

- `[backup-runner] backup runner started` + cấu hình concurrency.
- `[backup-job] start job_id=... destination=... total_objects=...`
- `[backup-object] copied account=... key=... bytes=... destination=...`
- `[backup-job] completed job_id=... done=... failed=0 durationMs=...`

### Log khi cấu hình thiếu

- Thiếu destination type trong API request:
  - `MISSING_DESTINATION_TYPE`
- Destination mock thiếu endpoint:
  - `mock destination requires endpoint`
- `BACKUP_ENABLED=false` trong worker:
  - `backup runner disabled (BACKUP_ENABLED=false)`
- Không có job pending:
  - chỉ poll im lặng hoặc log debug nhẹ theo chu kỳ.

### Log khi lỗi runtime

- Lỗi copy object (retry):
  - `backup copy failed` + `jobId`, `backendKey`, `attempt_count`, `error`
- Lỗi đồng bộ RTDB backup:
  - `backup RTDB PATCH ... failed: <status> <body>`
- Job hoàn tất nhưng có lỗi object:
  - status job = `failed`, `last_error` lưu tại `backup_jobs.last_error`.
