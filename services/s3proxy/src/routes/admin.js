/**
 * src/routes/admin.js
 * Lightweight admin UI + APIs for runtime status and S3 test actions.
 */

import { randomBytes } from 'crypto'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3'

import config from '../config.js'
import { getAllAccounts } from '../db.js'
import { getAccountsStats } from '../accountPool.js'
import { getRtdbState } from './health.js'
import { listCronJobs } from '../cronScheduler.js'
import { createS3Client } from '../inventoryScanner.js'

function formatPercent(used, quota) {
  if (!quota) return 0
  return Number(((used / quota) * 100).toFixed(2))
}

function toPublicAccount(row) {
  return {
    accountId: row.account_id,
    endpoint: row.endpoint,
    region: row.region,
    bucket: row.bucket,
    active: row.active === 1 || row.active === true,
    usedBytes: row.used_bytes ?? 0,
    quotaBytes: row.quota_bytes ?? 0,
    usedPercent: formatPercent(row.used_bytes ?? 0, row.quota_bytes ?? 0),
    addedAt: row.added_at ?? null,
  }
}

function renderAdminHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>S3Proxy Admin</title>
  <style>
    :root { color-scheme: dark; }
    body { font-family: Inter, Arial, sans-serif; margin: 0; background: #0b1020; color: #e5e7eb; }
    .wrap { max-width: 1120px; margin: 0 auto; padding: 24px; }
    .card { background: #111a31; border: 1px solid #223156; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
    h1, h2 { margin: 0 0 12px; }
    .meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
    .pill { padding: 8px 10px; background: #1a2745; border-radius: 8px; font-size: 13px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 8px; border-bottom: 1px solid #24355f; }
    button { cursor: pointer; border: 0; background: #2563eb; color: #fff; padding: 8px 12px; border-radius: 8px; }
    button.secondary { background: #374151; }
    .actions { display: flex; gap: 8px; margin-bottom: 10px; }
    .ok { color: #34d399; }
    .bad { color: #f87171; }
    pre { white-space: pre-wrap; word-break: break-word; background: #0f172a; padding: 10px; border-radius: 8px; }
  </style>
</head>
<body>
<div class="wrap">
  <h1>S3Proxy Admin</h1>
  <div class="actions">
    <button id="refreshBtn">Refresh trạng thái</button>
    <button id="testAllBtn" class="secondary">Test file operations (all active)</button>
  </div>

  <section class="card">
    <h2>Tổng quan</h2>
    <div class="meta" id="meta"></div>
  </section>

  <section class="card">
    <h2>Jobs (cron)</h2>
    <table>
      <thead><tr><th>Name</th><th>Expression</th><th>Timezone</th><th>Last run</th><th>Status</th></tr></thead>
      <tbody id="jobsBody"></tbody>
    </table>
  </section>

  <section class="card">
    <h2>Accounts</h2>
    <table>
      <thead><tr><th>Account</th><th>Bucket</th><th>Used/Quota</th><th>Percent</th><th>Status</th><th>Action</th></tr></thead>
      <tbody id="accountsBody"></tbody>
    </table>
  </section>

  <section class="card">
    <h2>Kết quả kiểm thử API file</h2>
    <pre id="log">(chưa chạy)</pre>
  </section>
</div>

<script>
const metaEl = document.getElementById('meta')
const jobsBody = document.getElementById('jobsBody')
const accountsBody = document.getElementById('accountsBody')
const logEl = document.getElementById('log')
const refreshBtn = document.getElementById('refreshBtn')
const testAllBtn = document.getElementById('testAllBtn')

function fmtBytes(bytes) {
  if (!bytes) return '0 B'
  const units = ['B','KB','MB','GB','TB']
  let value = bytes
  let idx = 0
  while (value >= 1024 && idx < units.length - 1) { value /= 1024; idx++ }
  return value.toFixed(2) + ' ' + units[idx]
}

function fmtTime(ts) {
  if (!ts) return '-'
  const d = new Date(ts)
  return d.toISOString().replace('T', ' ').slice(0, 16)
}

async function runTest(accountId) {
  logEl.textContent = 'Đang test account ' + accountId + '...'
  const res = await fetch('/admin/api/test-s3', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountId })
  })
  const body = await res.json()
  logEl.textContent = JSON.stringify(body, null, 2)
}

async function refresh() {
  const res = await fetch('/admin/api/overview')
  const body = await res.json()

  const healthClass = body.status === 'ok' ? 'ok' : 'bad'
  metaEl.innerHTML = `
    <div class="pill">Deploy version: <b>${body.deployVersion}</b></div>
    <div class="pill">Instance: <b>${body.instanceId}</b></div>
    <div class="pill">Status: <b class="${healthClass}">${body.status}</b></div>
    <div class="pill">Accounts active/total: <b>${body.stats.active}/${body.stats.total}</b></div>
    <div class="pill">Used total: <b>${fmtBytes(body.stats.usedBytes)} / ${fmtBytes(body.stats.totalBytes)}</b></div>
    <div class="pill">RTDB connected: <b>${body.rtdb.connected}</b> | listener: <b>${body.rtdb.listenerActive}</b></div>
  `

  jobsBody.innerHTML = body.jobs.map((job) => {
    const statusClass = job.lastRunStatus === 'ok' ? 'ok' : (job.lastRunStatus === 'error' ? 'bad' : '')
    return `<tr>
      <td>${job.name}</td>
      <td>${job.expression}</td>
      <td>${job.timezone}</td>
      <td>${fmtTime(job.lastRunAt)}</td>
      <td class="${statusClass}">${job.lastRunStatus || '-'}</td>
    </tr>`
  }).join('')

  accountsBody.innerHTML = body.accounts.map((account) => `
    <tr>
      <td>${account.accountId}</td>
      <td>${account.bucket}</td>
      <td>${fmtBytes(account.usedBytes)} / ${fmtBytes(account.quotaBytes)}</td>
      <td>${account.usedPercent}%</td>
      <td class="${account.active ? 'ok' : 'bad'}">${account.active ? 'active' : 'inactive'}</td>
      <td><button data-account="${account.accountId}">Test</button></td>
    </tr>
  `).join('')

  accountsBody.querySelectorAll('button[data-account]').forEach((button) => {
    button.addEventListener('click', () => runTest(button.getAttribute('data-account')))
  })
}

refreshBtn.addEventListener('click', refresh)
testAllBtn.addEventListener('click', async () => {
  logEl.textContent = 'Đang chạy test all active accounts...'
  const res = await fetch('/admin/api/test-s3', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ allActive: true })
  })
  const body = await res.json()
  logEl.textContent = JSON.stringify(body, null, 2)
})

refresh().catch((err) => { logEl.textContent = String(err) })
</script>
</body>
</html>`
}

function readStreamBodyToString(body) {
  if (!body) return Promise.resolve('')
  if (typeof body.transformToString === 'function') {
    return body.transformToString()
  }

  return new Promise((resolve, reject) => {
    const chunks = []
    body.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    body.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    body.on('error', reject)
  })
}

async function runS3Probe(account) {
  const client = createS3Client(account)
  const probeKey = `${config.ADMIN_TEST_PREFIX}/${account.account_id}-${Date.now()}-${randomBytes(3).toString('hex')}.txt`
  const payload = `s3proxy probe ${new Date().toISOString()}`

  const timings = {}
  const startedAt = Date.now()

  const t1 = Date.now()
  await client.send(new ListObjectsV2Command({ Bucket: account.bucket, MaxKeys: 3 }))
  timings.listMs = Date.now() - t1

  const t2 = Date.now()
  await client.send(new PutObjectCommand({
    Bucket: account.bucket,
    Key: probeKey,
    Body: payload,
    ContentType: 'text/plain; charset=utf-8',
  }))
  timings.putMs = Date.now() - t2

  const t3 = Date.now()
  const getResult = await client.send(new GetObjectCommand({ Bucket: account.bucket, Key: probeKey }))
  const fetchedPayload = await readStreamBodyToString(getResult.Body)
  timings.getMs = Date.now() - t3

  const t4 = Date.now()
  await client.send(new DeleteObjectCommand({ Bucket: account.bucket, Key: probeKey }))
  timings.deleteMs = Date.now() - t4

  return {
    accountId: account.account_id,
    bucket: account.bucket,
    probeKey,
    ok: fetchedPayload === payload,
    bytes: payload.length,
    durationMs: Date.now() - startedAt,
    timings,
    fetchedPayload,
  }
}

export default async function adminRoutes(fastify, _opts) {
  fastify.get('/admin', {
    config: { skipAuth: true },
  }, async (_request, reply) => {
    reply.type('text/html; charset=utf-8').send(renderAdminHtml())
  })

  fastify.get('/admin/api/overview', {
    config: { skipAuth: true },
  }, async (_request, reply) => {
    const stats = getAccountsStats()
    const accounts = getAllAccounts().map(toPublicAccount)
    const rtdb = getRtdbState()

    reply.send({
      status: rtdb.connected ? 'ok' : 'degraded',
      instanceId: config.INSTANCE_ID,
      deployVersion: config.DEPLOY_VERSION,
      stats,
      rtdb,
      jobs: listCronJobs(),
      accounts,
    })
  })

  fastify.post('/admin/api/test-s3', {
    config: { skipAuth: true },
  }, async (request, reply) => {
    const payload = request.body && typeof request.body === 'object' ? request.body : {}
    const all = getAllAccounts().filter((item) => item.active === 1 || item.active === true)

    let targets = []
    if (payload.allActive === true) {
      targets = all
    } else if (payload.accountId) {
      targets = all.filter((item) => item.account_id === String(payload.accountId))
    }

    if (targets.length === 0) {
      return reply.code(400).send({ ok: false, error: 'account not found or inactive' })
    }

    const results = []
    for (const account of targets) {
      try {
        const result = await runS3Probe(account)
        results.push(result)
      } catch (err) {
        results.push({
          accountId: account.account_id,
          bucket: account.bucket,
          ok: false,
          error: err?.message ?? String(err),
        })
      }
    }

    return reply.send({
      ok: results.every((item) => item.ok),
      count: results.length,
      results,
    })
  })
}
