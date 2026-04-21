# Backup System — Deployment Guide

## Architecture

Backup system có 2 thành phần:
1. **HTTP API** (`routes/backup.js`): Tích hợp trong main app, xử lý requests tạo/quản lý jobs.
2. **Backup Worker** (`backupRunner.js`): Process xử lý jobs, copy objects sang destination.

## Modes

### Mode 1: Embedded (khuyến nghị cho single-container)

Set `BACKUP_ENABLED=true`. Worker sẽ tự động start trong cùng process với main app.

```env
BACKUP_ENABLED=true
BACKUP_CONCURRENCY=2
BACKUP_RTDB_URL=https://your-backup-rtdb.firebasedatabase.app/backup.json?auth=xxx
```

Không cần chạy `backupRunner.js` riêng.

### Mode 2: Standalone Worker (khuyến nghị cho multi-container)

Set `BACKUP_ENABLED=false` trong main app (để tắt embedded worker).
Chạy `backupRunner.js` trong container riêng với `BACKUP_ENABLED=true`.

```yaml
# docker-compose example
services:
  s3proxy:
    environment:
      BACKUP_ENABLED: "false"  # Tắt embedded worker

  backup-worker:
    command: node src/backupRunner.js
    environment:
      BACKUP_ENABLED: "true"
      BACKUP_CONCURRENCY: "3"
```

Cả 2 containers chia sẻ cùng SQLite file qua volume mount.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| BACKUP_ENABLED | false | Bật/tắt backup system |
| BACKUP_RTDB_URL | "" | URL Firebase RTDB riêng cho backup (optional) |
| BACKUP_CONCURRENCY | 3 | Số object copy song song |
| BACKUP_CHUNK_STREAM_MS | 50 | Throttle delay giữa objects (ms) |
| BACKUP_MAX_OBJECT_SIZE_MB | 512 | Skip objects lớn hơn mức này |
| BACKUP_STALE_JOB_THRESHOLD_MS | 30000 | Thời gian không heartbeat → job bị coi là crashed |
| BACKUP_ZIP_TMP_DIR | os.tmpdir() | Thư mục lưu ZIP backup tạm thời |

## Lưu ý SQLite multi-process

Cả main app và backup worker đều truy cập cùng file SQLite.
`better-sqlite3` hỗ trợ đọc concurrent nhưng chỉ 1 writer tại 1 thời điểm.
WAL mode giúp giảm contention. Verify trong `db.js`:

```js
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')
```
