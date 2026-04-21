import pino from 'pino'
import config from './config.js'
import { runPendingBackupJobs } from './backup/backupManager.js'

const log = pino({
  level: config.LOG_LEVEL,
  ...(process.env.NODE_ENV !== 'production' ? {
    transport: { target: 'pino-pretty', options: { colorize: true } },
  } : {}),
})

if (!config.BACKUP_ENABLED) {
  log.info('backup runner disabled (BACKUP_ENABLED=false)')
  process.exit(0)
}

log.info({ concurrency: config.BACKUP_CONCURRENCY }, 'backup runner started')

async function loop() {
  try {
    const job = await runPendingBackupJobs(log)
    if (job) {
      log.info({ jobId: job.job_id, status: job.status }, 'backup job processed')
    }
  } catch (err) {
    log.error({ err }, 'backup loop error')
  }

  setTimeout(loop, 2000)
}

loop()
