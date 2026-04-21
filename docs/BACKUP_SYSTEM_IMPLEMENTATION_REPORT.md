# Backup System Implementation Report (Round 3)

## Mức độ khớp với review

- ✅ Đã fix auth cho toàn bộ `/admin/backup/*`.
- ✅ Đã sửa builder URL của backup RTDB để dùng đúng format khi `BACKUP_RTDB_URL` kết thúc bằng `/backup.json?auth=...`.
- ✅ Đã chuyển flow backup sang **scan inventory thật từ backend S3** (`scanAccountInventory`) thay vì chỉ đọc metadata SQLite.
- ✅ Có `resume_token` thực tế theo `accountId + continuationToken + lastKey` trong quá trình scan.
- ✅ RTDB backup sync chuyển sang **best effort** (log warning, không làm fail toàn job).
- ✅ Ledger đã tránh ghi đè sai trong multi-account/multi-destination bằng unique key theo `(job_id, account_id, backend_key, destination_type)`.
- ✅ Đã thực thi runtime options `BACKUP_MAX_OBJECT_SIZE_MB`, `dryRun`, `includeRtdb`.
- ✅ Progress đã cập nhật theo từng object (`currentAccountId`, `currentKey`, `percentDone`).
- ✅ API trả job đã sanitize secret trong `destination_config`.
- ✅ Route create job trả lỗi 400 nếu destination type không support.
- ✅ 404 nguồn trong worker xử lý thành `skipped`.
- ✅ Đã thêm health/metrics/validate-env cho backup ở mức cơ bản.

## Phần còn lại chưa full-plan

- ⏳ `restoreManager` và `backendReplacer` mới dừng ở mức contract/stub.
- ⏳ Destinations `gdrive`, `onedrive`, `zip` chưa hoàn tất production logic.
- ⏳ Chưa có locking phân tán cứng (leader election) nếu scale nhiều `backup-worker` instance.
