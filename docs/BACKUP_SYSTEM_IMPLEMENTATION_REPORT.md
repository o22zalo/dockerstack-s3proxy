# Backup System Implementation Report (Round 4)

## Đã xử lý thêm các lỗi trọng yếu

- ✅ Pause/cancel theo hướng DB-driven tốt hơn cho kiến trúc tách container (worker kiểm tra trạng thái job trong DB khi chạy).
- ✅ Không còn ghi đè `resume_token` khi pause.
- ✅ `updateJobStatus` cho phép clear thật sự các trường `last_error`, `completed_at`, `resume_token` (không giữ rác qua lần chạy).
- ✅ Bổ sung `markLedgerSkipped` và phản ánh chuẩn các case skipped/dryRun/404/object-too-large.
- ✅ Sửa progress để không bị cộng trùng khi có nhiều destination (count theo source-object).
- ✅ Giảm rủi ro memory: không giữ mảng `tasks[]` vô hạn, dùng `inFlight Set` + `Promise.race` để giới hạn.
- ✅ App API trả 501 rõ ràng cho các flow restore/migrate/replace đang stub.
- ✅ Đồng bộ cấu hình `BACKUP_ENABLED` của app theo `BACKUP_SYSTEM_ENABLE` để tránh báo sai trạng thái.
- ✅ Destination contract mở rộng thêm các method nền tảng (`read/exists/listKeys/delete/getMetadata`) cho local/s3 (mock ở mức not implemented).

## Trạng thái full-plan hiện tại

- ⏳ Chưa full implementation business logic cho restore/backend replacement (mới trả 501/stub rõ ràng).
- ⏳ Chưa hoàn tất destinations `gdrive`, `onedrive`, `zip`.
- ⏳ Chưa có distributed lock/leader election cứng khi scale nhiều worker instance.
