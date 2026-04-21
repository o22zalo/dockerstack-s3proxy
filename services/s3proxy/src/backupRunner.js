process.env.BACKUP_RUNNER_STANDALONE = 'true'

import pino from 'pino'
import config from './config.js'
import { initBackupManager, stopBackupManager } from './backup/backupManager.js'

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

if (config.BACKUP_PROCESSING_MODE !== 'embedded') {
  log.error({ mode: config.BACKUP_PROCESSING_MODE }, 'backup runner requires BACKUP_PROCESSING_MODE=embedded')
  process.exit(1)
}

const manager = initBackupManager(log, 2000, { keepAlive: true })
log.info({
  concurrency: config.BACKUP_CONCURRENCY,
  mode: config.BACKUP_PROCESSING_MODE,
  managerStarted: manager.started,
}, 'backup runner started')

const shutdown = (signal) => {
  log.info({ signal }, 'backup runner shutting down')
  stopBackupManager()
  process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

setInterval(() => {}, 2 ** 30)
