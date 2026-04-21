/**
 * src/routes/health.js
 * GET /health — no auth required.
 */

import { getAccountsStats } from '../accountPool.js'
import { countRoutes } from '../db.js'
import { cacheSize } from '../cache.js'
import config from '../config.js'
import { getRunningJob, listJobs } from '../backup/backupJournal.js'

let _rtdbState = { connected: false, listenerActive: false }

export function setRtdbState(state) {
  _rtdbState = { ..._rtdbState, ...state }
}

export function getRtdbState() {
  return _rtdbState
}

export default async function healthRoutes(fastify, _opts) {
  fastify.get('/health', {
    config: { skipAuth: true },
  }, async (request, reply) => {
    let sqliteOk = true
    let routeCount = 0
    let accountStats = { total: 0, active: 0, full: 0, totalBytes: 0, usedBytes: 0 }

    try {
      routeCount = countRoutes({ visibleOnly: true })
      accountStats = getAccountsStats()
    } catch (err) {
      sqliteOk = false
      request.log.error({ err }, 'health: SQLite query failed')
    }

    const status = (!sqliteOk && !_rtdbState.connected) ? 503 : 200
    const percentUsed = accountStats.totalBytes > 0
      ? Number(((accountStats.usedBytes / accountStats.totalBytes) * 100).toFixed(2))
      : 0

    reply.code(status).send({
      status: status === 200 ? 'ok' : 'degraded',
      instanceId: fastify.config?.INSTANCE_ID ?? process.env.INSTANCE_ID ?? 'unknown',
      uptime: Number(process.uptime().toFixed(2)),
      accounts: {
        total: accountStats.total,
        active: accountStats.active,
        full: accountStats.full,
      },
      routes: {
        sqliteCount: routeCount,
        cacheSize: cacheSize(),
      },
      rtdb: {
        connected: _rtdbState.connected,
        listenerActive: _rtdbState.listenerActive,
      },
      quota: {
        totalBytes: accountStats.totalBytes,
        usedBytes: accountStats.usedBytes,
        percentUsed,
      },
      backup: (() => {
        try {
          const running = getRunningJob?.()
          const recentJobs = listJobs?.({ limit: 1, offset: 0, status: 'completed' }) ?? []
          const lastCompleted = recentJobs[0] ?? null
          return {
            enabled: config.BACKUP_ENABLED,
            rtdbConfigured: Boolean(config.BACKUP_RTDB_URL),
            runningJobs: running ? 1 : 0,
            lastCompletedJob: lastCompleted ? {
              jobId: lastCompleted.job_id,
              completedAt: lastCompleted.completed_at,
              status: lastCompleted.status,
              totalObjects: lastCompleted.total_objects,
              doneObjects: lastCompleted.done_objects,
            } : null,
          }
        } catch {
          return { enabled: config.BACKUP_ENABLED, rtdbConfigured: Boolean(config.BACKUP_RTDB_URL) }
        }
      })(),
    })
  })
}
