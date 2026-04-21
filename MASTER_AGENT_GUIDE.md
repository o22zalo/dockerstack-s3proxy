# MASTER AGENT GUIDE — Backup System Fix & Improvement
# Hướng dẫn tổng quan cho agents trước khi bắt đầu bất kỳ sprint nào

---

## Overview

Đây là bộ 6 prompts để fix bugs và cải tiến hệ thống backup của `dockerstack-s3proxy`. Tất cả prompts được thiết kế để agents thực thi **tuần tự, không song song**.

```
SPRINT 1 → SPRINT 2 → SPRINT 3 → SPRINT 4 → SPRINT 5 → SPRINT 6
```

Mỗi sprint có prerequisite là sprint trước đã complete. Không được skip sprint.

> Sprint 1–4 đã được thực thi và có implementation report. Agents mới chỉ cần chạy từ **Sprint 5**.

---

## Thứ tự thực hiện và scope

| Sprint | File | Scope | Prerequisite | Priority | Trạng thái |
|---|---|---|---|---|---|
| Sprint 1 | `SPRINT1_PROMPT_P0_BUGS.md` | BUG-1, BUG-2, BUG-3 | Không có | 🔴 Critical | ✅ Done |
| Sprint 2 | `SPRINT2_PROMPT_P1_BUGS.md` | BUG-4, BUG-5, BUG-6 | Sprint 1 done | 🟠 Important | ✅ Done |
| Sprint 3 | `SPRINT3_PROMPT_P2_PERF.md` | BUG-7, BUG-8, BUG-9 + PERF-1~4 | Sprint 2 done | 🟡 Moderate | ✅ Done |
| Sprint 4 | `SPRINT4_PROMPT_ADMIN_UI.md` | Admin UI hoàn thiện | Sprint 3 done | 🟢 Enhancement | ✅ Done |
| Sprint 5 | `SPRINT5_PROMPT_P0_REMAINING.md` | BUG-10, BUG-11 | Sprint 4 done | 🔴 Critical | ⬜ TODO |
| Sprint 6 | `SPRINT6_PROMPT_P1_IMPROVEMENTS.md` | FIX-1, FIX-2 | Sprint 5 done | 🟠 Important | ⬜ TODO |

---

## Bugs được fix theo sprint

### Sprint 1 — Critical (làm ngay, không trì hoãn)

| Bug | Mô tả | Files bị ảnh hưởng |
|---|---|---|
| BUG-1 | RAM buffer trong restore/migrate → OOM với file lớn | `restoreManager.js`, `backendReplacer.js` |
| BUG-2 | `backend_migrations` bảng không bao giờ được ghi | `backendReplacer.js`, `routes/backup.js` |
| BUG-3 | ZIP download endpoint broken — không có stream logic | `routes/backup.js`, `backupManager.js`, `backupJournal.js` |

### Sprint 2 — Important

| Bug | Mô tả | Files bị ảnh hưởng |
|---|---|---|
| BUG-4 | Race condition: stale "running" job block queue mãi | `backupManager.js`, `config.js`, `.env.example` |
| BUG-5 | `initBackupManager` không có trong `index.js` — không document | `index.js`, `backupRunner.js`, `docs/` |
| BUG-6 | Restore xong không sync routes lên production RTDB | `restoreManager.js` |

### Sprint 3 — Moderate + Performance

| Item | Mô tả | Files bị ảnh hưởng |
|---|---|---|
| BUG-7 | GDrive `read()` mất state sau restart | `gdriveDest.js`, `restoreManager.js` |
| BUG-8 | API path prefix khác plan (doc fix, không đổi code) | `docs/BACKUP_API_REFERENCE.md` (file mới) |
| BUG-9 | BACKUP_ENABLED=false nhưng routes vẫn active | `routes/backup.js` |
| PERF-1 | Batch upsert ledger entries per page | `backupJournal.js`, `backupManager.js` |
| PERF-2 | Composite index cho getPendingLedgerEntries | `db.js` |
| PERF-3 | Throttle updateJobProgress — không gọi mỗi object | `backupManager.js` |
| PERF-4 | `migrationObjectsTotal` metric chưa được increment | `backendReplacer.js` |

### Sprint 4 — Enhancement ✅ Done

| Item | Mô tả | Files bị ảnh hưởng |
|---|---|---|
| UI-1 | Dynamic config fields theo destinationType (6 loại) | `admin-ui.html` |
| UI-2 | Jobs table: progress bar, auto-refresh, download link | `admin-ui.html` |
| UI-3 | Backend health panel mới | `admin-ui.html` |
| UI-4 | Restore panel mới | `admin-ui.html` |

### Sprint 5 — Critical (phát hiện sau review post Sprint 1–4)

| Bug | Mô tả | Files bị ảnh hưởng |
|---|---|---|
| BUG-10 | `replaceBackendConfig` và `rollbackMigration` không gọi `reloadAccountsFromSQLite()` sau `upsertAccount()` → in-memory account pool dùng credentials cũ sau khi replace | `backup/backendReplacer.js` |
| BUG-11 | `/api/cron-jobs/:jobId/run` thiếu auth → bất kỳ request nào trigger được cron job; test fail từ Sprint 1 | `routes/admin.js` |

### Sprint 6 — Important (cải tiến kỹ thuật)

| Item | Mô tả | Files bị ảnh hưởng |
|---|---|---|
| FIX-1 | `s3Dest.upload()` buffer objects ≤5MB vào RAM thay vì stream → RAM spike với concurrent backup | `backup/destinations/s3Dest.js` |
| FIX-2 | `startRestoreJob()` không persist vào `backup_jobs` → không track được lịch sử restore | `backup/restoreManager.js` |

---

## Quy tắc chung cho TẤT CẢ agents (PHẢI tuân thủ)

### 1. Đọc trước khi code
Trước khi sửa bất kỳ file nào, đọc toàn bộ file đó. Không patch mù dựa vào code snippet trong prompt.

### 2. Không được bỏ sót checklist
Mỗi sprint có bảng "So sánh với prompt gốc" trong report template. Tất cả hạng mục phải là ✅ hoặc ❌ với giải thích rõ ràng.

### 3. Không được thay đổi ngoài scope
Nếu phát hiện bug khác trong khi làm, ghi vào report phần "Vấn đề phát hiện thêm" — KHÔNG fix trong sprint đó trừ khi prompt cho phép.

### 4. Test sau mỗi sprint
```bash
cd services/s3proxy
npm test 2>&1 | tail -30
```
Nếu test fail do code của sprint đó → phải fix trước khi submit report.

### 5. Report là bắt buộc
Không submit sprint nếu chưa có report file. Report phải có:
- Bảng so sánh với prompt
- Verify commands output (paste thực tế, không fake)
- Vấn đề gặp phải
- Test results

### 6. Grep verify trước khi submit
Mỗi sprint có danh sách grep commands để verify. Chạy tất cả và paste output vào report. Không được bỏ qua bước này.

---

## Files được tạo mới trong các sprints

| Sprint | Files mới tạo |
|---|---|
| Sprint 1 | `docs/SPRINT1_IMPLEMENTATION_REPORT.md` |
| Sprint 2 | `docs/backup-deployment.md`, `docs/SPRINT2_IMPLEMENTATION_REPORT.md` |
| Sprint 3 | `docs/BACKUP_API_REFERENCE.md`, `docs/SPRINT3_IMPLEMENTATION_REPORT.md` |
| Sprint 4 | `docs/SPRINT4_IMPLEMENTATION_REPORT.md` |
| Sprint 5 | `docs/SPRINT5_IMPLEMENTATION_REPORT.md` |
| Sprint 6 | `docs/SPRINT6_IMPLEMENTATION_REPORT.md` |

---

## Files được sửa đổi

| File | Sprint 1 | Sprint 2 | Sprint 3 | Sprint 4 | Sprint 5 | Sprint 6 |
|---|---|---|---|---|---|---|
| `src/backup/restoreManager.js` | ✏️ BUG-1, BUG-2 | ✏️ BUG-6 | ✏️ BUG-7 | — | — | ✏️ FIX-2 |
| `src/backup/backendReplacer.js` | ✏️ BUG-1, BUG-2 | — | ✏️ PERF-4 | — | ✏️ BUG-10 | — |
| `src/routes/admin.js` | — | — | — | — | ✏️ BUG-11 | — |
| `src/routes/backup.js` | ✏️ BUG-2, BUG-3 | — | ✏️ BUG-9 | — | — | — |
| `src/backup/backupManager.js` | ✏️ BUG-3 | ✏️ BUG-4 | ✏️ PERF-1, PERF-3 | — | — | — |
| `src/backup/backupJournal.js` | ✏️ BUG-3 | — | ✏️ PERF-1 | — | — | — |
| `src/backup/destinations/gdriveDest.js` | — | — | ✏️ BUG-7 | — | — | — |
| `src/backup/destinations/s3Dest.js` | — | — | — | — | — | ✏️ FIX-1 |
| `src/config.js` | — | ✏️ BUG-4 | — | — | — | — |
| `src/index.js` | — | ✏️ BUG-5 | — | — | — | — |
| `src/backupRunner.js` | — | ✏️ BUG-5 | — | — | — | — |
| `src/db.js` | — | ✏️ WAL check | ✏️ PERF-2 | — | — | — |
| `.env.example` | — | ✏️ BUG-4 | — | — | — | — |
| `src/admin-ui.html` | — | — | — | ✏️ UI-1~4 | — | — |

---

## Cách đọc prompt

Mỗi file prompt có cấu trúc:
1. **CONTEXT** — background, tech stack, thứ tự làm
2. **BUG-N / PERF-N / TASK-N** — mô tả vấn đề + fix chi tiết
3. **Verify** — commands để kiểm tra sau khi fix
4. **CLEANUP** — lệnh chạy sau toàn bộ sprint
5. **BÁO CÁO BẮT BUỘC** — template report phải điền đầy đủ

Đọc từ đầu đến cuối trước khi bắt đầu code.

---

## Thời gian ước tính

| Sprint | Ước tính (1 agent) | Trạng thái |
|---|---|---|
| Sprint 1 | 30-60 phút | ✅ Done |
| Sprint 2 | 20-40 phút | ✅ Done |
| Sprint 3 | 20-40 phút | ✅ Done |
| Sprint 4 | 45-90 phút | ✅ Done |
| Sprint 5 | 15-25 phút | ⬜ TODO |
| Sprint 6 | 20-35 phút | ⬜ TODO |

---

## Liên kết tham chiếu

- **Báo cáo review gốc:** `docs/BACKUP_SYSTEM_REVIEW.md`
- **Plan gốc:** `docs/BACKUP_SYSTEM_PLAN.md`
- **Implementation report (trước các sprints):** `docs/BACKUP_SYSTEM_IMPLEMENTATION_REPORT.md`
