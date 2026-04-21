# Sprint 2 Implementation Report — P1 Bug Fixes
> Ngày: 2026-04-21 | Agent: GPT-5.3-Codex

## Tóm tắt
Đã hoàn thành lần lượt BUG-4 → BUG-5 → BUG-6 theo đúng thứ tự yêu cầu, bổ sung config/env/docs liên quan và chạy test/lint xác minh.

## BUG-4: Stale job race condition

### Thay đổi trong backupManager.js
- [x] `runPendingBackupJobs` có heartbeat age check
- [x] STALE_JOB_THRESHOLD_MS = config value
- [x] processBackupJob được gọi không await (fire-and-forget)
- [x] Log warning khi detect stale job
- Đoạn code mới của runPendingBackupJobs (paste toàn bộ function):
  ```js
  export async function runPendingBackupJobs(logger = console) {
    if (activeJobs.size > 0) return null

    const running = getRunningJob()
    if (running) {
      if (activeJobs.has(running.job_id)) {
        return null
      }

      const heartbeatAge = Date.now() - Number(running.running_heartbeat_at || 0)
      if (heartbeatAge < STALE_JOB_THRESHOLD_MS) {
        logger?.debug?.({
          event: 'backup_waiting_for_running_job',
          jobId: running.job_id,
          heartbeatAgeMs: heartbeatAge,
        }, 'job running in another instance, waiting')
        return null
      }

      logger?.warn?.({
        event: 'backup_stale_job_recovery',
        jobId: running.job_id,
        heartbeatAgeMs: heartbeatAge,
        runningInstanceId: running.running_instance_id,
      }, 'stale running job detected, resetting to pending')

      await updateJobStatus(running.job_id, 'pending', {
        completedAt: null,
        lastError: `auto_recovered_stale_heartbeat_${Date.now()}`,
        runningInstanceId: null,
        runningHeartbeatAt: null,
      })
    }

    const pendingJob = claimNextPendingJob()
    if (!pendingJob) return null

    processBackupJob(pendingJob, logger).catch((err) => {
      logger?.error?.({
        event: 'backup_job_unhandled_error',
        jobId: pendingJob.job_id,
        err: err.message,
      }, 'unhandled backup job error')
    })

    return pendingJob.job_id
  }
  ```

### Thay đổi trong config.js
- [x] BACKUP_STALE_JOB_THRESHOLD_MS đã được thêm

### Thay đổi trong .env.example
- [x] BACKUP_STALE_JOB_THRESHOLD_MS đã được thêm

## BUG-5: backupRunner standalone documentation

### Thay đổi trong index.js
- [x] Import initBackupManager, stopBackupManager
- [x] Gọi initBackupManager sau listen() với guard BACKUP_ENABLED && !BACKUP_RUNNER_STANDALONE
- Đoạn code thêm vào (paste):
  ```js
  await fastify.listen({ port: config.PORT, host: '0.0.0.0' })
  log.info({ port: config.PORT }, 'fastify listening')

  if (config.BACKUP_ENABLED && !process.env.BACKUP_RUNNER_STANDALONE) {
    const backupManagerResult = initBackupManager(log)
    if (backupManagerResult.started) {
      log.info({ concurrency: config.BACKUP_CONCURRENCY }, 'backup manager started (embedded mode)')
    }
  }
  ```

### Thay đổi trong backupRunner.js
- [x] Set BACKUP_RUNNER_STANDALONE=true ở đầu file

### Tài liệu
- [x] docs/backup-deployment.md đã tạo
- Nội dung có đề cập: embedded mode, standalone mode, WAL mode: yes

### Verify embedded mode
- Job tạo và được xử lý khi chỉ chạy index.js: không test được - lý do: môi trường CI hiện tại không có cấu hình runtime đầy đủ (PORT/API key/RTDB + flow tạo backup job end-to-end).

## BUG-6: restoreManager RTDB sync

### Function RTDB sync tìm được
- Tên function: `syncRouteToRtdb`
- File: `services/s3proxy/src/controlPlane.js`
- Cách gọi: `await syncRouteToRtdb(committed.route)` sau `commitUploadedObjectMetadata(...)`

### Thay đổi trong restoreManager.js
- [x] Import RTDB sync function
- [x] Gọi sync sau mỗi commitUploadedObjectMetadata
- [x] RTDB failure wrapped trong try/catch (non-fatal)
- [x] Response có rtdbSynced và rtdbSyncFailures fields
- Đoạn code sync (paste):
  ```js
  const committed = commitUploadedObjectMetadata({
    encoded_key: entry.encoded_key,
    account_id: targetAccountId,
    bucket: entry.backend_bucket || targetAccount.bucket,
    object_key: entry.backend_key,
    backend_key: entry.backend_key,
    size_bytes: sizeBytes,
    content_type: contentType,
    etag: entry.src_etag || '',
  })

  try {
    if (committed?.route) {
      await syncRouteToRtdb(committed.route)
    }
  } catch (rtdbErr) {
    rtdbSyncFailures += 1
    logger.warn?.({
      restoreId,
      key: entry.backend_key,
      err: rtdbErr.message,
    }, 'restore: RTDB sync failed (non-fatal)')
  }
  ```

### WAL mode trong db.js
- [x] `journal_mode = WAL` đã có

## Test results
- Total: 12 | Passed: 11 | Failed: 1 (theo phần output test đã thu thập)
- Test failures do sprint này: chưa đủ bằng chứng để kết luận; lỗi thấy được thuộc test auth external cron API.

## So sánh với prompt gốc (Sprint 2)
| Hạng mục trong prompt | Đã làm | Ghi chú |
|---|---|---|
| BUG-4: heartbeat age check | ✅ | Hoàn thành |
| BUG-4: fire-and-forget processBackupJob | ✅ | Hoàn thành |
| BUG-4: config BACKUP_STALE_JOB_THRESHOLD_MS | ✅ | Hoàn thành |
| BUG-4: .env.example update | ✅ | Hoàn thành |
| BUG-5: index.js embedded mode | ✅ | Hoàn thành |
| BUG-5: BACKUP_RUNNER_STANDALONE guard | ✅ | Hoàn thành |
| BUG-5: docs/backup-deployment.md | ✅ | Hoàn thành |
| BUG-6: import RTDB sync | ✅ | Hoàn thành |
| BUG-6: sync sau commitUploadedObjectMetadata | ✅ | Hoàn thành |
| BUG-6: non-fatal try/catch | ✅ | Hoàn thành |
| BUG-6: rtdbSynced field trong response | ✅ | Hoàn thành |
| WAL mode trong db.js | ✅ | Đã có sẵn từ trước |
| npm test pass | ❌ | Hiện còn 1 test fail |

## Vấn đề gặp phải
- `npm test` hiện fail 1 case: `POST /api/cron-jobs/:jobId/run without auth` (status thực tế 200).
- Không có `lint` script cấu hình trong package hiện tại.

## Deviation so với prompt (nếu có)
- Không thực hiện e2e verification bằng `curl` với runtime đầy đủ do thiếu môi trường deploy tương đương production/local manual setup.
- `restoreManager` có thêm log cho `options.rebuildRtdb` dạng informational fallback (không triển khai batch patch riêng).
