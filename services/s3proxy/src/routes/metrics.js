/**
 * src/routes/metrics.js
 * GET /metrics — Prometheus text format, no auth required.
 */

import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client'
import {
  getActiveObjectStatsByBucket,
  getBackupJobStatusCounts,
  getLogicalBytesByBucketAccount,
  getRouteStateCountsByAccount,
} from '../db.js'
import { listJobs } from '../backup/backupJournal.js'

export const register = new Registry()
register.setDefaultLabels({ service: 's3proxy' })
collectDefaultMetrics({ register })

export const metrics = {
  requestsTotal: new Counter({
    name: 's3proxy_requests_total',
    help: 'Total S3 proxy requests',
    labelNames: ['method', 'operation', 'status_code'],
    registers: [register],
  }),

  uploadBytesTotal: new Counter({
    name: 's3proxy_upload_bytes_total',
    help: 'Total bytes uploaded per account',
    labelNames: ['account_id'],
    registers: [register],
  }),

  downloadBytesTotal: new Counter({
    name: 's3proxy_download_bytes_total',
    help: 'Total bytes downloaded per account',
    labelNames: ['account_id'],
    registers: [register],
  }),

  accountUsedBytes: new Gauge({
    name: 's3proxy_account_used_bytes',
    help: 'Current used bytes per account',
    labelNames: ['account_id'],
    registers: [register],
  }),

  accountQuotaBytes: new Gauge({
    name: 's3proxy_account_quota_bytes',
    help: 'Quota bytes per account',
    labelNames: ['account_id'],
    registers: [register],
  }),

  rtdbSyncLagMs: new Gauge({
    name: 's3proxy_rtdb_sync_lag_ms',
    help: 'Time since last RTDB event in milliseconds',
    registers: [register],
  }),

  cacheHitsTotal: new Counter({
    name: 's3proxy_cache_hits_total',
    help: 'LRU cache hits',
    registers: [register],
  }),

  cacheMissesTotal: new Counter({
    name: 's3proxy_cache_misses_total',
    help: 'LRU cache misses',
    registers: [register],
  }),

  retryTotal: new Counter({
    name: 's3proxy_retry_total',
    help: 'Retry attempts per operation',
    labelNames: ['operation'],
    registers: [register],
  }),

  fallbackTotal: new Counter({
    name: 's3proxy_fallback_total',
    help: 'Fallback triggers per reason',
    labelNames: ['reason'],
    registers: [register],
  }),

  metadataBackedListRequestsTotal: new Counter({
    name: 's3proxy_metadata_list_requests_total',
    help: 'Metadata-backed list requests',
    labelNames: ['status_code'],
    registers: [register],
  }),

  metadataLookupDurationSeconds: new Histogram({
    name: 's3proxy_metadata_lookup_duration_seconds',
    help: 'Metadata lookup latency by source',
    labelNames: ['source'],
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
    registers: [register],
  }),

  metadataCommitFailuresTotal: new Counter({
    name: 's3proxy_metadata_commit_failures_total',
    help: 'Metadata commit failures',
    labelNames: ['stage'],
    registers: [register],
  }),

  reconcilerMismatchTotal: new Counter({
    name: 's3proxy_reconciler_mismatches_total',
    help: 'Reconciler mismatches by type and account',
    labelNames: ['type', 'account_id'],
    registers: [register],
  }),

  orphanBackendObjects: new Gauge({
    name: 's3proxy_orphan_backend_objects',
    help: 'Backend objects without trusted logical metadata',
    labelNames: ['account_id'],
    registers: [register],
  }),

  missingBackendObjects: new Gauge({
    name: 's3proxy_missing_backend_objects',
    help: 'Metadata rows whose backend object is missing',
    labelNames: ['account_id'],
    registers: [register],
  }),

  activeLogicalObjects: new Gauge({
    name: 's3proxy_active_logical_objects',
    help: 'Active logical objects by bucket',
    labelNames: ['bucket'],
    registers: [register],
  }),

  logicalObjectBytes: new Gauge({
    name: 's3proxy_logical_object_bytes',
    help: 'Active logical object bytes by bucket and account',
    labelNames: ['bucket', 'account_id'],
    registers: [register],
  }),
  backupJobsByStatus: new Gauge({
    name: 's3proxy_backup_jobs_by_status',
    help: 'Backup job count grouped by status',
    labelNames: ['status'],
    registers: [register],
  }),
  backupObjectsTotal: new Counter({
    name: 's3proxy_backup_objects_total',
    help: 'Objects processed by backup system',
    labelNames: ['status', 'destination_type'],
    registers: [register],
  }),
  backupBytesTotal: new Counter({
    name: 's3proxy_backup_bytes_total',
    help: 'Bytes transferred by backup system',
    labelNames: ['destination_type'],
    registers: [register],
  }),
  backupJobDurationSeconds: new Histogram({
    name: 's3proxy_backup_job_duration_seconds',
    help: 'Backup job duration in seconds',
    labelNames: ['type', 'status'],
    buckets: [60, 300, 600, 1800, 3600, 7200],
    registers: [register],
  }),
  migrationObjectsTotal: new Counter({
    name: 's3proxy_migration_objects_total',
    help: 'Objects migrated between backends',
    labelNames: ['status'],
    registers: [register],
  }),
}

export function refreshMetadataMetrics() {
  metrics.activeLogicalObjects.reset()
  metrics.logicalObjectBytes.reset()
  metrics.orphanBackendObjects.reset()
  metrics.missingBackendObjects.reset()
  metrics.backupJobsByStatus.reset()

  for (const row of getActiveObjectStatsByBucket()) {
    metrics.activeLogicalObjects.set({ bucket: row.bucket }, row.object_count)
  }

  for (const row of getLogicalBytesByBucketAccount()) {
    metrics.logicalObjectBytes.set({ bucket: row.bucket, account_id: row.account_id }, row.total_bytes)
  }

  for (const row of getRouteStateCountsByAccount()) {
    if (row.state === 'ORPHANED') {
      metrics.orphanBackendObjects.set({ account_id: row.account_id }, row.object_count)
    }
    if (row.state === 'MISSING_BACKEND') {
      metrics.missingBackendObjects.set({ account_id: row.account_id }, row.object_count)
    }
  }

  for (const row of getBackupJobStatusCounts()) {
    metrics.backupJobsByStatus.set({ status: row.status }, row.total)
  }

  try {
    const completedJobs = listJobs({ limit: 100, status: 'completed' })
    for (const job of completedJobs) {
      if (job.started_at && job.completed_at) {
        const duration = (job.completed_at - job.started_at) / 1000
        metrics.backupJobDurationSeconds.observe({ type: job.type || 'full', status: 'completed' }, duration)
      }
    }
  } catch {}
}

export default async function metricsRoutes(fastify, _opts) {
  fastify.get('/metrics', {
    config: { skipAuth: true },
  }, async (_request, reply) => {
    const output = await register.metrics()
    reply
      .code(200)
      .header('Content-Type', register.contentType)
      .send(output)
  })
}
