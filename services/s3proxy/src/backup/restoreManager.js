import { randomUUID } from 'crypto'

export async function startRestoreJob({ sourceJobId, sourceDestination, targetAccountMapping = {}, options = {}, logger = console }) {
  const restoreId = `restore_${randomUUID()}`
  logger.info?.({ sourceJobId, restoreId, targetAccountMapping, options }, 'restore requested (stub)')
  return {
    restoreId,
    status: 'not_implemented',
    message: 'restoreManager MVP chưa triển khai đầy đủ; chỉ nhận request và trả metadata stub',
    sourceJobId,
    sourceDestination,
  }
}

export async function verifyRestoreIntegrity(jobId, _sourceDestination) {
  return {
    jobId,
    status: 'not_implemented',
    mismatches: [],
  }
}
