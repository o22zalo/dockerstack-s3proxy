/**
 * src/cronScheduler.js
 * Configurable cron scheduler + keepalive jobs (extensible registry).
 */

import { ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3'

import config from './config.js'
import { getAllActiveAccounts } from './db.js'
import { createS3Client } from './inventoryScanner.js'

const jobs = new Map()
let schedulerTimer = null

function parseCronField(field, min, max) {
  const normalized = String(field).trim()
  if (normalized === '*') return { any: true, values: null }
  if (normalized.startsWith('*/')) {
    const step = Number.parseInt(normalized.slice(2), 10)
    if (!Number.isFinite(step) || step <= 0) return null
    return { any: false, step, values: null }
  }

  const values = new Set()
  for (const chunk of normalized.split(',')) {
    const value = Number.parseInt(chunk.trim(), 10)
    if (!Number.isFinite(value) || value < min || value > max) return null
    values.add(value)
  }
  return { any: false, step: null, values }
}

function parseCronExpression(expression) {
  const fields = String(expression).trim().split(/\s+/)
  if (fields.length !== 5) return null
  const [minuteRaw, hourRaw, dayRaw, monthRaw, weekdayRaw] = fields
  const minute = parseCronField(minuteRaw, 0, 59)
  const hour = parseCronField(hourRaw, 0, 23)
  const day = parseCronField(dayRaw, 1, 31)
  const month = parseCronField(monthRaw, 1, 12)
  const weekday = parseCronField(weekdayRaw, 0, 6)
  if (!minute || !hour || !day || !month || !weekday) return null
  return { minute, hour, day, month, weekday }
}

function matchField(rule, value) {
  if (!rule) return false
  if (rule.any) return true
  if (rule.step) return value % rule.step === 0
  return rule.values?.has(value) ?? false
}

function shouldRun(descriptor, date = new Date()) {
  const rule = descriptor.parsedExpression
  if (!rule) return false
  return matchField(rule.minute, date.getUTCMinutes())
    && matchField(rule.hour, date.getUTCHours())
    && matchField(rule.day, date.getUTCDate())
    && matchField(rule.month, date.getUTCMonth() + 1)
    && matchField(rule.weekday, date.getUTCDay())
}

function normalizeMode(mode = '') {
  const value = String(mode).trim().toLowerCase()
  if (['touch', 'put'].includes(value)) return 'touch'
  return 'scan'
}

async function runKeepaliveScan(account, logger) {
  const client = createS3Client(account)
  await client.send(new ListObjectsV2Command({
    Bucket: account.bucket,
    MaxKeys: 1,
    Prefix: config.CRON_KEEPALIVE_PREFIX,
  }))
  logger.info?.({ accountId: account.account_id, bucket: account.bucket }, 'cron keepalive scan ok')
}

async function runKeepaliveTouch(account, logger) {
  const client = createS3Client(account)
  const key = `${config.CRON_KEEPALIVE_PREFIX.replace(/\/$/, '')}/${account.account_id}.txt`
  const payload = `${config.CRON_KEEPALIVE_CONTENT_PREFIX} ${new Date().toISOString()}\n`

  await client.send(new PutObjectCommand({
    Bucket: account.bucket,
    Key: key,
    Body: payload,
    ContentType: 'text/plain; charset=utf-8',
  }))

  logger.info?.({ accountId: account.account_id, key }, 'cron keepalive touch ok')
}

export function registerCronJob(name, expression, runner, options = {}) {
  const parsed = parseCronExpression(expression)
  if (!expression || !parsed) {
    throw new Error(`Invalid cron expression for ${name}: ${expression}`)
  }

  const descriptor = {
    name,
    expression,
    timezone: options.timezone || config.CRON_TIMEZONE,
    runOnStartup: Boolean(options.runOnStartup),
    enabled: true,
    task: null,
    runner,
    parsedExpression: parsed,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunError: null,
  }

  jobs.set(name, descriptor)
  return descriptor
}

async function runDescriptor(descriptor) {
  descriptor.lastRunAt = Date.now()
  try {
    await descriptor.runner()
    descriptor.lastRunStatus = 'ok'
    descriptor.lastRunError = null
  } catch (err) {
    descriptor.lastRunStatus = 'error'
    descriptor.lastRunError = err?.message ?? String(err)
    throw err
  }
}

function buildKeepaliveRunner(logger) {
  return async () => {
    const accounts = getAllActiveAccounts()
    const mode = normalizeMode(config.CRON_KEEPALIVE_MODE)

    if (accounts.length === 0) {
      logger.warn?.('cron keepalive skipped: no active account')
      return
    }

    for (const account of accounts) {
      if (mode === 'touch') {
        await runKeepaliveTouch(account, logger)
      } else {
        await runKeepaliveScan(account, logger)
      }
    }
  }
}

export async function startCronScheduler(logger = console) {
  if (!config.CRON_ENABLED) {
    logger.info?.('cron scheduler disabled by CRON_ENABLED=false')
    return
  }

  if (config.CRON_KEEPALIVE_ENABLED) {
    const keepalive = registerCronJob(
      'supabase-keepalive',
      config.CRON_KEEPALIVE_EXPRESSION,
      buildKeepaliveRunner(logger),
      {
        timezone: config.CRON_TIMEZONE,
        runOnStartup: config.CRON_RUN_ON_START,
        logger,
      },
    )

    if (keepalive.runOnStartup) {
      runDescriptor(keepalive).catch((err) => {
        logger.error?.({ err }, 'initial keepalive run failed')
      })
    }
  }

  if (schedulerTimer) clearInterval(schedulerTimer)
  schedulerTimer = setInterval(() => {
    const now = new Date()
    for (const descriptor of jobs.values()) {
      if (!descriptor.enabled) continue
      if (!shouldRun(descriptor, now)) continue

      const minuteKey = now.toISOString().slice(0, 16)
      if (descriptor.lastTriggerMinute === minuteKey) continue
      descriptor.lastTriggerMinute = minuteKey

      runDescriptor(descriptor).catch((err) => {
        logger.error?.({ err, job: descriptor.name }, 'cron job failed')
      })
    }
  }, 10_000)
  schedulerTimer.unref?.()

  logger.info?.({ jobs: listCronJobs() }, 'cron scheduler started')
}

export function stopCronScheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer)
  schedulerTimer = null
  jobs.clear()
}

export function listCronJobs() {
  return [...jobs.values()].map((job) => ({
    name: job.name,
    expression: job.expression,
    timezone: job.timezone,
    enabled: job.enabled,
    lastRunAt: job.lastRunAt,
    lastRunStatus: job.lastRunStatus,
    lastRunError: job.lastRunError,
  }))
}
