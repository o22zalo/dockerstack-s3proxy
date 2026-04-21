# Backup API Reference

> Lưu ý: Implementation thực tế dùng path prefix `/admin/backup/` (không có `/api/`).
> Tài liệu plan cũ có chỗ ghi `/admin/api/backup/`; đây là khác biệt có chủ ý để đồng nhất với các admin endpoints khác.

## Endpoints

### Jobs

| Method | Path | Mô tả |
|---|---|---|
| GET | `/admin/backup/jobs` | Danh sách backup jobs |
| POST | `/admin/backup/jobs` | Tạo backup job mới |
| GET | `/admin/backup/jobs/:jobId` | Chi tiết job |
| POST | `/admin/backup/jobs/:jobId/stop` | Stop job |
| POST | `/admin/backup/jobs/:jobId/pause` | Pause job |
| POST | `/admin/backup/jobs/:jobId/resume` | Resume/Retry job |
| DELETE | `/admin/backup/jobs/:jobId` | Xóa job record |
| GET | `/admin/backup/jobs/:jobId/ledger` | Xem ledger (phân trang) |
| GET | `/admin/backup/jobs/:jobId/download` | Download ZIP (zip jobs) |
| GET | `/admin/backup/jobs/:jobId/events` | SSE progress stream |

### Restore

| Method | Path | Mô tả |
|---|---|---|
| POST | `/admin/backup/restore` | Tạo restore job |
| GET | `/admin/backup/restore/:jobId/verify` | Verify integrity |

### Backend Management

| Method | Path | Mô tả |
|---|---|---|
| GET | `/admin/backup/backends/:accountId/health` | Check health backend |
| GET | `/admin/backup/backends/:accountId/diagnose` | Diagnose backend |
| POST | `/admin/backup/backends/replace-config` | Replace config backend |
| POST | `/admin/backup/backends/migrate` | Migrate objects |
| GET | `/admin/backup/backends/migrations` | List migrations |
| POST | `/admin/backup/backends/migrations/:id/rollback` | Rollback migration |

### Config

| Method | Path | Mô tả |
|---|---|---|
| GET | `/admin/backup/config` | Lấy cấu hình backup hiện tại |
| POST | `/admin/backup/config/test` | Test backup config (nếu bật trong server) |

## Authentication

Tất cả endpoints yêu cầu header:

```http
x-api-key: <ADMIN_API_KEY>
```
