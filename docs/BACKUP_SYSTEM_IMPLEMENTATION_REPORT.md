# Backup System Implementation Report (Round 5)

## Đã xử lý thêm theo feedback mới

- ✅ `localDest.listKeys()` đã có recursive enumerate thực tế.
- ✅ Manager thêm guard để tránh chạy chồng nhiều job (không claim pending mới khi đã có running/active).
- ✅ Có auto-heal cho job `running` bị treo sau restart: chuyển về `pending` để worker xử lý tiếp.
- ✅ Delete job an toàn hơn: chặn cả theo persisted DB status `running`, không chỉ memory map.
- ✅ Worker có status polling timer (1s) để abort signal sớm hơn khi pause/cancel từ app.
- ✅ `resumeToken.lastKey` được dùng fallback khi không có continuation token.
- ✅ Bắt đầu dùng `getPendingLedgerEntries()` như seed flow cho retry/resume trước khi scan inventory lại.
- ✅ Route `diagnose` trả `501 Not Implemented` cho trạng thái stub, đồng bộ với restore/migrate.

## Vẫn còn chưa full-plan

- ⏳ `restoreManager` / `backendReplacer` vẫn chưa có business logic hoàn chỉnh.
- ⏳ Thiếu destination `gdrive`, `onedrive`, `zip`.
- ⏳ Cơ chế distributed lock nhiều worker instance vẫn chưa production-grade tuyệt đối.
