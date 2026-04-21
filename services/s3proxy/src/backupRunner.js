import pino from 'pino'
import config from './config.js'
import { initBackupManager } from './backup/backupManager.js'

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
initBackupManager(log, 2000)
