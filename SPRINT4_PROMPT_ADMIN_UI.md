# AGENT PROMPT — SPRINT 4: Admin UI — Backup Tab Đầy Đủ (P3)
# Backup System — Hoàn thiện admin-ui.html backup tab
# Prerequisite: Sprint 1, 2, 3 đã hoàn thành

---

## CONTEXT

File: `services/s3proxy/src/admin-ui.html`

Tab backup hiện tại rất minimal: chỉ có form tạo job (3 fields đơn giản) và table jobs. Cần thêm đủ 4 sub-sections theo plan, cộng với một số UX improvements.

**QUAN TRỌNG VỀ STYLE:** Admin UI đang dùng CSS variables và class names riêng của project (`card`, `stack`, `section-head`, `actions`, `table-wrap`, `responsive-table`, `tab-panel`, v.v.). Trước khi code, đọc phần CSS của file để nắm class names — KHÔNG tự đặt class names mới nếu có sẵn. Tất cả HTML thêm vào phải match style hiện tại.

**Đọc trước khi làm:**
```bash
# Xem các class CSS đang dùng trong backup tab hiện tại
sed -n '415,445p' services/s3proxy/src/admin-ui.html

# Xem JavaScript hiện tại của backup tab
grep -n "backup\|backupForm\|backupJob" services/s3proxy/src/admin-ui.html | tail -30

# Xem CSS variables và base styles
grep -n ":root\|--color\|--font\|\.card\|\.stack\|\.section-head\|\.actions" \
  services/s3proxy/src/admin-ui.html | head -50
```

---

## TASK 1: Cải tiến Section 1 — Form tạo backup job

### Hiện tại (minimal):
- Select: local/mock/s3 (thiếu gdrive, onedrive, zip)
- 1 textarea JSON cho toàn bộ config
- Không có dynamic fields

### Yêu cầu: Dynamic form fields theo destinationType

**Thay thế `<form id="backupForm">` hiện tại bằng:**

```html
<form id="backupForm">
  <div class="form-row">
    <label for="backupDestinationType">Destination</label>
    <select id="backupDestinationType">
      <option value="local">local — Local filesystem</option>
      <option value="s3">s3 — S3-compatible (Supabase, R2, MinIO...)</option>
      <option value="gdrive">gdrive — Google Drive</option>
      <option value="onedrive">onedrive — OneDrive / SharePoint</option>
      <option value="zip">zip — Download ZIP (local file)</option>
      <option value="mock">mock — Dry-run mock</option>
    </select>
  </div>

  <!-- Dynamic config fields — hiển thị theo destinationType -->
  <div id="backupConfigFields" class="stack"></div>

  <div class="form-row">
    <label for="backupAccountFilter">Account filter</label>
    <input id="backupAccountFilter" placeholder="Để trống = all accounts. Nhập account IDs cách nhau bởi dấu phẩy." />
  </div>

  <div class="form-row">
    <label>Options</label>
    <div class="checkbox-group">
      <label><input type="checkbox" id="optSkipExisting" checked /> skipExistingByEtag</label>
      <label><input type="checkbox" id="optIncludeRtdb" /> includeRtdb</label>
      <label><input type="checkbox" id="optDryRun" /> dryRun (không copy thực)</label>
    </div>
  </div>

  <div class="actions">
    <button type="submit" id="backupCreateBtn">Tạo backup job</button>
  </div>
</form>
```

**Config field templates** (thêm vào `<script>` section, thay thế JS backup cũ):

```js
// Config templates theo destinationType
const DEST_CONFIG_TEMPLATES = {
  local: `
    <div class="form-row">
      <label>Root directory</label>
      <input name="rootDir" placeholder="/backup-data" value="/backup-data" />
    </div>`,
  s3: `
    <div class="form-row">
      <label>Endpoint</label>
      <input name="endpoint" placeholder="https://project.supabase.co/storage/v1/s3" />
    </div>
    <div class="form-row">
      <label>Access Key ID</label>
      <input name="accessKeyId" placeholder="access-key-id" />
    </div>
    <div class="form-row">
      <label>Secret Key</label>
      <input name="secretKey" type="password" placeholder="secret-key" />
    </div>
    <div class="form-row">
      <label>Bucket</label>
      <input name="bucket" placeholder="my-backup-bucket" />
    </div>
    <div class="form-row">
      <label>Region</label>
      <input name="region" placeholder="us-east-1" value="us-east-1" />
    </div>
    <div class="form-row">
      <label>Prefix (optional)</label>
      <input name="prefix" placeholder="daily/" />
    </div>`,
  gdrive: `
    <div class="form-row">
      <label>Access Token</label>
      <input name="accessToken" type="password" placeholder="ya29.xxx" />
    </div>
    <div class="form-row">
      <label>Folder ID</label>
      <input name="folderId" placeholder="1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs" />
    </div>`,
  onedrive: `
    <div class="form-row">
      <label>Access Token</label>
      <input name="accessToken" type="password" placeholder="eyJ0..." />
    </div>
    <div class="form-row">
      <label>Folder ID</label>
      <input name="folderId" placeholder="01XXXXX" />
    </div>
    <div class="form-row">
      <label>Drive ID (optional)</label>
      <input name="driveId" placeholder="b!xxx (leave empty for personal drive)" />
    </div>`,
  zip: `
    <div class="hint">ZIP sẽ được lưu vào thư mục tmp trên server. Download sau khi job completed.</div>`,
  mock: `
    <div class="hint">Mock destination — không copy object thực. Dùng để test.</div>`,
}

// Render config fields khi đổi destinationType
function renderDestConfigFields(type) {
  const container = document.getElementById('backupConfigFields')
  container.innerHTML = DEST_CONFIG_TEMPLATES[type] || ''
}

// Collect config từ dynamic fields
function collectDestConfig(type) {
  const container = document.getElementById('backupConfigFields')
  const inputs = container.querySelectorAll('input[name]')
  const config = {}
  inputs.forEach((input) => {
    if (input.value.trim()) config[input.name] = input.value.trim()
  })
  return config
}

// Init
const backupDestinationType = document.getElementById('backupDestinationType')
backupDestinationType?.addEventListener('change', () => {
  renderDestConfigFields(backupDestinationType.value)
})
renderDestConfigFields(backupDestinationType?.value || 'local') // Render ngay khi load
```

---

## TASK 2: Cải tiến Section 2 — Jobs table với progress bar và auto-refresh

### Yêu cầu:
- Progress bar thực sự (HTML `<progress>`)
- Hiển thị bytes + percentage
- Auto-refresh mỗi 3s khi có job đang running
- Nút Download cho zip jobs đã completed

**Sửa phần render table jobs** trong JavaScript:

```js
let backupAutoRefreshInterval = null

function startBackupAutoRefresh() {
  if (backupAutoRefreshInterval) return
  backupAutoRefreshInterval = setInterval(() => {
    loadBackupJobs(true) // silent refresh
  }, 3000)
}

function stopBackupAutoRefresh() {
  if (backupAutoRefreshInterval) {
    clearInterval(backupAutoRefreshInterval)
    backupAutoRefreshInterval = null
  }
}

function fmtBytes(bytes) {
  const b = Number(bytes || 0)
  if (b === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(b) / Math.log(1024))
  return `${(b / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
}

function renderBackupJobs(jobs) {
  const tbody = document.getElementById('backupJobsBody')
  if (!jobs || jobs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="hint">Chưa có backup job nào.</td></tr>'
    return
  }

  const hasRunning = jobs.some((j) => j.status === 'running')
  if (hasRunning) startBackupAutoRefresh()
  else stopBackupAutoRefresh()

  tbody.innerHTML = jobs.map((job) => {
    const totalObj = Number(job.total_objects || 0)
    const doneObj = Number(job.done_objects || 0)
    const failedObj = Number(job.failed_objects || 0)
    const pct = job.progress?.percentDone ?? (totalObj > 0 ? Math.round((doneObj / totalObj) * 100) : 0)

    const progressBar = totalObj > 0
      ? `<progress value="${doneObj}" max="${totalObj}" title="${pct}%"></progress>
         <span class="hint">${doneObj}/${totalObj} (${pct}%) · ${fmtBytes(job.done_bytes)}/${fmtBytes(job.total_bytes)}</span>`
      : `<span class="hint">—</span>`

    const isRunning = job.status === 'running'
    const isPaused = job.status === 'paused'
    const isCompleted = job.status === 'completed'

    const actions = [
      isRunning ? `<button class="ghost small" data-action="pause" data-jobid="${job.job_id}">Pause</button>` : '',
      isRunning ? `<button class="ghost small" data-action="stop" data-jobid="${job.job_id}">Stop</button>` : '',
      isPaused ? `<button class="ghost small" data-action="resume" data-jobid="${job.job_id}">Resume</button>` : '',
      job.status === 'failed' ? `<button class="ghost small" data-action="resume" data-jobid="${job.job_id}">Retry</button>` : '',
      isCompleted && job.destination_type === 'zip'
        ? `<a href="/admin/backup/jobs/${job.job_id}/download" class="ghost small btn" download>Download ZIP</a>` : '',
      !isRunning ? `<button class="ghost small danger" data-action="delete" data-jobid="${job.job_id}">Delete</button>` : '',
    ].filter(Boolean).join(' ')

    const statusClass = { running: 'status-running', completed: 'status-ok', failed: 'status-error', paused: 'status-warn', pending: 'status-pending' }[job.status] || ''

    return `<tr>
      <td><code style="font-size:0.8em">${job.job_id.slice(0, 16)}…</code></td>
      <td><span class="${statusClass}">${job.status}</span></td>
      <td>${job.destination_type}</td>
      <td>${progressBar}</td>
      <td>${new Date(job.created_at).toLocaleString()}</td>
      <td>${actions}</td>
    </tr>`
  }).join('')
}

async function loadBackupJobs(silent = false) {
  if (!silent) setButtonBusy(backupRefreshBtn, true, 'Refreshing...')
  try {
    const data = await api('/admin/backup/jobs?limit=30')
    renderBackupJobs(data.jobs || [])
    if (!silent) backupLog.textContent = JSON.stringify(data.jobs?.slice(0, 3), null, 2)
  } catch (err) {
    if (!silent) backupLog.textContent = String(err)
  } finally {
    if (!silent) setButtonBusy(backupRefreshBtn, false, 'Refresh jobs')
  }
}
```

Thêm cột "Created" vào `<thead>`:
```html
<thead><tr>
  <th>Job ID</th>
  <th>Status</th>
  <th>Dest</th>
  <th>Progress</th>
  <th>Created</th>
  <th>Actions</th>
</tr></thead>
```

---

## TASK 3: Thêm Section 3 — Backend Health Panel

Thêm vào `<section class="tab-panel" id="tab-backup">`, sau `</div>` của jobs section:

```html
<!-- Section 3: Backend Health -->
<div class="card stack">
  <div class="section-head">
    <div>
      <h2>Backend Health</h2>
      <div class="sub">Kiểm tra health và diagnose S3 backends. Dùng khi backend gặp sự cố.</div>
    </div>
    <div class="actions">
      <button id="backendHealthRefreshBtn" class="secondary">Check All</button>
    </div>
  </div>
  <div class="table-wrap">
    <table class="responsive-table">
      <thead><tr>
        <th>Account ID</th><th>Endpoint</th><th>Health</th><th>Latency</th><th>Actions</th>
      </tr></thead>
      <tbody id="backendHealthBody">
        <tr><td colspan="5" class="hint">Nhấn "Check All" để kiểm tra.</td></tr>
      </tbody>
    </table>
  </div>

  <!-- Replace Config Form -->
  <details id="replaceConfigDetails" style="margin-top:1rem">
    <summary style="cursor:pointer;font-weight:600">Replace Backend Config</summary>
    <div class="stack" style="margin-top:0.75rem">
      <div class="hint">Thay credentials/endpoint mà không copy data. Dùng khi chỉ đổi credentials.</div>
      <div class="form-row">
        <label>Account ID</label>
        <input id="replaceSourceAccountId" placeholder="account-id-to-replace" />
      </div>
      <div class="form-row">
        <label>New Endpoint</label>
        <input id="replaceEndpoint" placeholder="https://new.endpoint.example.com/storage/v1/s3" />
      </div>
      <div class="form-row">
        <label>New Access Key ID</label>
        <input id="replaceAccessKeyId" placeholder="new-access-key" />
      </div>
      <div class="form-row">
        <label>New Secret Key</label>
        <input id="replaceSecretKey" type="password" placeholder="new-secret" />
      </div>
      <div class="form-row">
        <label>New Bucket</label>
        <input id="replaceBucket" placeholder="new-bucket-name" />
      </div>
      <div class="actions">
        <button id="replaceConfigDryRunBtn" class="secondary">Dry Run</button>
        <button id="replaceConfigBtn" class="danger">Replace Config</button>
      </div>
    </div>
  </details>

  <!-- Migrate Objects Form -->
  <details id="migrateDetails" style="margin-top:0.5rem">
    <summary style="cursor:pointer;font-weight:600">Migrate Objects Between Backends</summary>
    <div class="stack" style="margin-top:0.75rem">
      <div class="hint">Copy toàn bộ objects từ source sang target account. Dùng khi backend bị down.</div>
      <div class="form-row">
        <label>Source Account ID</label>
        <input id="migrateSource" placeholder="broken-account-id" />
      </div>
      <div class="form-row">
        <label>Target Account ID</label>
        <input id="migrateTarget" placeholder="healthy-account-id" />
      </div>
      <div class="form-row">
        <label>Options</label>
        <div class="checkbox-group">
          <label><input type="checkbox" id="migrateSkipExisting" checked /> skipExistingByEtag</label>
          <label><input type="checkbox" id="migrateDeleteSource" /> deleteSource sau khi copy xong</label>
        </div>
      </div>
      <div class="actions">
        <button id="migrateDryRunBtn" class="secondary">Dry Run</button>
        <button id="migrateBtn" class="danger">Start Migration</button>
      </div>
    </div>
  </details>

  <pre id="backendHealthLog" style="max-height:200px;overflow-y:auto;">(chưa có kết quả)</pre>
</div>
```

**JavaScript cho backend health section:**

```js
const backendHealthBody = document.getElementById('backendHealthBody')
const backendHealthLog = document.getElementById('backendHealthLog')
const backendHealthRefreshBtn = document.getElementById('backendHealthRefreshBtn')

async function checkAllBackendHealth() {
  const release = setButtonBusy(backendHealthRefreshBtn, true, 'Checking...')
  try {
    // Lấy danh sách accounts từ API hiện có
    const accountsData = await api('/admin/accounts')
    const accounts = accountsData.accounts || []

    if (accounts.length === 0) {
      backendHealthBody.innerHTML = '<tr><td colspan="5" class="hint">Không có account nào.</td></tr>'
      return
    }

    // Check health song song
    backendHealthBody.innerHTML = '<tr><td colspan="5" class="hint">Checking...</td></tr>'
    const results = await Promise.allSettled(
      accounts.map((acc) =>
        api(`/admin/backup/backends/${encodeURIComponent(acc.account_id)}/health`)
          .then((r) => ({ accountId: acc.account_id, endpoint: acc.endpoint, ...r.result }))
          .catch((err) => ({ accountId: acc.account_id, endpoint: acc.endpoint, ok: false, error: err.message }))
      )
    )

    backendHealthBody.innerHTML = results.map((r) => {
      const d = r.status === 'fulfilled' ? r.value : { accountId: '?', ok: false, error: r.reason?.message }
      const healthBadge = d.ok
        ? `<span class="status-ok">✓ Healthy</span>`
        : `<span class="status-error">✗ ${d.error || 'Error'}</span>`
      return `<tr>
        <td><code>${d.accountId}</code></td>
        <td><span class="hint" style="word-break:break-all">${d.endpoint || '—'}</span></td>
        <td>${healthBadge}</td>
        <td>${d.ok ? `${d.latencyMs}ms` : '—'}</td>
        <td>
          <button class="ghost small" onclick="diagnoseAccount('${d.accountId}')">Diagnose</button>
        </td>
      </tr>`
    }).join('')
  } catch (err) {
    backendHealthLog.textContent = String(err)
  } finally {
    release()
  }
}

async function diagnoseAccount(accountId) {
  backendHealthLog.textContent = `Diagnosing ${accountId}...`
  try {
    const result = await api(`/admin/backup/backends/${encodeURIComponent(accountId)}/diagnose`)
    backendHealthLog.textContent = JSON.stringify(result.result, null, 2)
  } catch (err) {
    backendHealthLog.textContent = String(err)
  }
}

// Replace config
document.getElementById('replaceConfigBtn')?.addEventListener('click', async () => {
  const accountId = document.getElementById('replaceSourceAccountId').value.trim()
  if (!accountId) return alert('Nhập Account ID')
  if (!confirm(`Replace config cho account "${accountId}"? Thao tác này sẽ thay đổi credentials ngay lập tức.`)) return
  const newConfig = {
    endpoint: document.getElementById('replaceEndpoint').value.trim() || undefined,
    accessKeyId: document.getElementById('replaceAccessKeyId').value.trim() || undefined,
    secretKey: document.getElementById('replaceSecretKey').value.trim() || undefined,
    bucket: document.getElementById('replaceBucket').value.trim() || undefined,
  }
  Object.keys(newConfig).forEach((k) => newConfig[k] === undefined && delete newConfig[k])
  try {
    const result = await api('/admin/backup/backends/replace-config', {
      method: 'POST', body: { sourceAccountId: accountId, newAccountConfig: newConfig, dryRun: false }
    })
    backendHealthLog.textContent = JSON.stringify(result, null, 2)
  } catch (err) { backendHealthLog.textContent = String(err) }
})

document.getElementById('replaceConfigDryRunBtn')?.addEventListener('click', async () => {
  const accountId = document.getElementById('replaceSourceAccountId').value.trim()
  if (!accountId) return alert('Nhập Account ID')
  try {
    const result = await api('/admin/backup/backends/replace-config', {
      method: 'POST', body: { sourceAccountId: accountId, newAccountConfig: {}, dryRun: true }
    })
    backendHealthLog.textContent = JSON.stringify(result, null, 2)
  } catch (err) { backendHealthLog.textContent = String(err) }
})

// Migrate
document.getElementById('migrateBtn')?.addEventListener('click', async () => {
  const source = document.getElementById('migrateSource').value.trim()
  const target = document.getElementById('migrateTarget').value.trim()
  if (!source || !target) return alert('Nhập Source và Target account ID')
  if (!confirm(`Migrate objects từ "${source}" sang "${target}"? Đây là thao tác không thể hoàn tác tự động nếu deleteSource=true.`)) return
  try {
    const result = await api('/admin/backup/backends/migrate', {
      method: 'POST', body: {
        sourceAccountId: source,
        targetAccountId: target,
        options: {
          skipExistingByEtag: document.getElementById('migrateSkipExisting').checked,
          deleteSource: document.getElementById('migrateDeleteSource').checked,
          dryRun: false,
        }
      }
    })
    backendHealthLog.textContent = JSON.stringify(result, null, 2)
  } catch (err) { backendHealthLog.textContent = String(err) }
})

document.getElementById('migrateDryRunBtn')?.addEventListener('click', async () => {
  const source = document.getElementById('migrateSource').value.trim()
  const target = document.getElementById('migrateTarget').value.trim()
  if (!source || !target) return alert('Nhập Source và Target account ID')
  try {
    const result = await api('/admin/backup/backends/migrate', {
      method: 'POST', body: {
        sourceAccountId: source, targetAccountId: target,
        options: { dryRun: true }
      }
    })
    backendHealthLog.textContent = JSON.stringify(result, null, 2)
  } catch (err) { backendHealthLog.textContent = String(err) }
})

backendHealthRefreshBtn?.addEventListener('click', checkAllBackendHealth)
```

---

## TASK 4: Thêm Section 4 — Restore Panel

Thêm vào trong `<section class="tab-panel" id="tab-backup">`, sau backend health section:

```html
<!-- Section 4: Restore -->
<div class="card stack">
  <div class="section-head">
    <div>
      <h2>Restore</h2>
      <div class="sub">Restore objects từ một backup job đã completed.</div>
    </div>
  </div>

  <div class="form-row">
    <label for="restoreSourceJobId">Source Job ID</label>
    <select id="restoreSourceJobId">
      <option value="">— Chọn backup job đã completed —</option>
    </select>
  </div>

  <div class="form-row">
    <label>Source destination type</label>
    <select id="restoreSourceDestType">
      <option value="local">local</option>
      <option value="s3">s3</option>
      <option value="gdrive">gdrive</option>
      <option value="onedrive">onedrive</option>
    </select>
  </div>
  <div id="restoreSourceConfigFields" class="stack"></div>

  <div class="form-row">
    <label>Account mapping <span class="hint">(JSON: {"old_id": "new_id"}, để trống = restore vào account gốc)</span></label>
    <textarea id="restoreAccountMapping" placeholder='{}'>{}</textarea>
  </div>

  <div class="form-row">
    <label>Options</label>
    <div class="checkbox-group">
      <label><input type="checkbox" id="restoreDryRun" /> dryRun</label>
      <label><input type="checkbox" id="restoreRebuildRtdb" checked /> rebuildRtdb</label>
    </div>
  </div>

  <div class="actions">
    <button id="restoreStartBtn" class="secondary">Start Restore</button>
  </div>

  <pre id="restoreLog" style="max-height:250px;overflow-y:auto;">(chưa có kết quả restore)</pre>
</div>
```

**JavaScript cho restore section:**

```js
const restoreSourceJobId = document.getElementById('restoreSourceJobId')
const restoreSourceDestType = document.getElementById('restoreSourceDestType')
const restoreSourceConfigFields = document.getElementById('restoreSourceConfigFields')
const restoreLog = document.getElementById('restoreLog')

// Load completed jobs vào select
async function loadCompletedJobsForRestore() {
  try {
    const data = await api('/admin/backup/jobs?limit=50&status=completed')
    const jobs = data.jobs || []
    restoreSourceJobId.innerHTML = '<option value="">— Chọn backup job —</option>'
      + jobs.map((j) => `<option value="${j.job_id}">${j.job_id.slice(0,16)}… | ${j.destination_type} | ${j.done_objects} objs | ${new Date(j.created_at).toLocaleDateString()}</option>`).join('')
  } catch {}
}

// Reuse DEST_CONFIG_TEMPLATES từ Task 1 cho restore source config
restoreSourceDestType?.addEventListener('change', () => {
  restoreSourceConfigFields.innerHTML = DEST_CONFIG_TEMPLATES[restoreSourceDestType.value] || ''
})
restoreSourceConfigFields.innerHTML = DEST_CONFIG_TEMPLATES['local']

document.getElementById('restoreStartBtn')?.addEventListener('click', async () => {
  const jobId = restoreSourceJobId.value
  if (!jobId) return alert('Chọn source job')

  const sourceConfig = collectDestConfig(restoreSourceDestType.value) // reuse function từ Task 1
  // Note: collectDestConfig đọc từ backupConfigFields (form chính), cần đọc từ restoreSourceConfigFields
  // Implement inline hoặc refactor collectDestConfig để accept container element

  let accountMapping = {}
  try { accountMapping = JSON.parse(document.getElementById('restoreAccountMapping').value || '{}') } catch { return alert('Account mapping JSON không hợp lệ') }

  if (!confirm(`Start restore từ job ${jobId}? Thao tác này sẽ overwrite objects trong destination accounts.`)) return

  const release = setButtonBusy(document.getElementById('restoreStartBtn'), true, 'Restoring...')
  try {
    const result = await api('/admin/backup/restore', {
      method: 'POST',
      body: {
        sourceJobId: jobId,
        sourceDestinationType: restoreSourceDestType.value,
        sourceDestinationConfig: sourceConfig,
        targetAccountMapping: accountMapping,
        options: {
          dryRun: document.getElementById('restoreDryRun').checked,
          rebuildRtdb: document.getElementById('restoreRebuildRtdb').checked,
        }
      }
    })
    restoreLog.textContent = JSON.stringify(result, null, 2)
  } catch (err) {
    restoreLog.textContent = String(err)
  } finally {
    release()
  }
})

// Load completed jobs khi mở tab backup
// (thêm vào event handler khi click tab backup)
```

---

## TASK 5: Tab event handler và khởi tạo

Tìm event handler khi click tab backup (search `data-tab="backup"` hoặc tab switching logic trong JS). Thêm vào handler:

```js
// Khi tab backup được mở:
loadBackupJobs()
loadCompletedJobsForRestore()
renderDestConfigFields(backupDestinationType?.value || 'local')
```

---

## TASK 6: Thêm `collectDestConfig` cho restore

Refactor `collectDestConfig` để accept custom container:

```js
function collectDestConfig(type, containerEl = null) {
  const container = containerEl || document.getElementById('backupConfigFields')
  const inputs = container?.querySelectorAll('input[name]') || []
  const config = {}
  inputs.forEach((input) => {
    if (input.value.trim()) config[input.name] = input.value.trim()
  })
  return config
}
```

Trong restore handler, gọi:
```js
const sourceConfig = collectDestConfig(restoreSourceDestType.value, restoreSourceConfigFields)
```

---

## CLEANUP VÀ VERIFY

```bash
# Kiểm tra syntax HTML không bị broken
node -e "
const fs = require('fs')
const html = fs.readFileSync('services/s3proxy/src/admin-ui.html', 'utf8')
// Kiểm tra các IDs quan trọng tồn tại
const ids = ['backupDestinationType','backupConfigFields','optSkipExisting','optDryRun',
  'backendHealthBody','backendHealthRefreshBtn','replaceConfigBtn','migrateBtn',
  'restoreSourceJobId','restoreStartBtn']
ids.forEach(id => {
  if (!html.includes(id)) console.log('MISSING:', id)
  else console.log('OK:', id)
})
"

# Kiểm tra không có syntax error JS
node --check services/s3proxy/src/admin-ui.html 2>&1 | head -5
# Note: node --check chỉ check JS files. Với HTML cần browser để test.
```

**Manual verification (bắt buộc):**
1. Mở admin UI trong browser
2. Click tab "Backup"
3. Verify: Select có đủ 6 options (local/s3/gdrive/onedrive/zip/mock)
4. Đổi sang S3 → verify dynamic fields xuất hiện (endpoint, accessKeyId, secretKey, bucket, region, prefix)
5. Đổi sang GDrive → verify fields thay đổi (accessToken, folderId)
6. Đổi sang ZIP → verify hint text xuất hiện
7. Click "Check All" trong Backend Health → verify table update
8. Verify Restore panel có select dropdown jobs
9. Tạo 1 backup job → verify nó xuất hiện trong table và progress bar hiển thị
10. Verify auto-refresh 3s khi job đang running

---

## BÁO CÁO BẮT BUỘC

Tạo `docs/SPRINT4_IMPLEMENTATION_REPORT.md`:

```markdown
# Sprint 4 Implementation Report — Admin UI
> Ngày: YYYY-MM-DD | Agent: [tên/version]

## Tóm tắt

## TASK 1: Dynamic form fields

- [ ] Select có 6 options (local/s3/gdrive/onedrive/zip/mock)
- [ ] DEST_CONFIG_TEMPLATES object đủ 6 loại
- [ ] renderDestConfigFields() hoạt động
- [ ] collectDestConfig() lấy values từ dynamic fields
- [ ] Checkboxes options: skipExistingByEtag, includeRtdb, dryRun
- Screenshot hoặc HTML snippet của form:
  ```html
  [paste backupForm HTML]
  ```

## TASK 2: Jobs table improvements

- [ ] Cột "Created" đã thêm
- [ ] fmtBytes() function
- [ ] Progress bar `<progress>` element
- [ ] Auto-refresh mỗi 3s khi có job running
- [ ] Download link cho zip jobs completed
- [ ] startBackupAutoRefresh / stopBackupAutoRefresh functions
- Snippet renderBackupJobs():
  ```js
  [paste function signature + key lines]
  ```

## TASK 3: Backend Health panel

- [ ] Section HTML đã thêm vào tab-backup
- [ ] Table với columns: Account ID, Endpoint, Health, Latency, Actions
- [ ] "Check All" gọi API health cho tất cả accounts song song
- [ ] diagnoseAccount() function
- [ ] Replace Config form (dryRun + live)
- [ ] Migrate form (dryRun + live)
- [ ] backendHealthLog `<pre>` hiển thị kết quả JSON

## TASK 4: Restore panel

- [ ] Section HTML đã thêm
- [ ] restoreSourceJobId select tự load completed jobs
- [ ] Dynamic source config fields (reuse DEST_CONFIG_TEMPLATES)
- [ ] Account mapping textarea
- [ ] dryRun + rebuildRtdb checkboxes
- [ ] Gọi /admin/backup/restore API

## TASK 5: Tab init handler

- [ ] loadBackupJobs() gọi khi mở tab backup
- [ ] loadCompletedJobsForRestore() gọi khi mở tab
- [ ] renderDestConfigFields() được init ngay

## TASK 6: collectDestConfig với custom container

- [ ] Đã refactor để accept containerEl parameter
- [ ] Restore handler dùng restoreSourceConfigFields

## Verify output (grep IDs)
```
[paste output của node verify script]
```

## Manual browser verification
- [ ] Tab mở không có JS error
- [ ] Select có 6 options
- [ ] Dynamic fields hoạt động
- [ ] Backend health check all hoạt động
- [ ] Restore panel load completed jobs
- [ ] Progress bar hiển thị

## So sánh với prompt gốc (Sprint 4)
| Hạng mục | Đã làm | Ghi chú |
|---|---|---|
| TASK 1: 6 dest options | ✅/❌ | |
| TASK 1: DEST_CONFIG_TEMPLATES | ✅/❌ | |
| TASK 1: dynamic render | ✅/❌ | |
| TASK 2: progress bar | ✅/❌ | |
| TASK 2: auto-refresh | ✅/❌ | |
| TASK 2: download zip link | ✅/❌ | |
| TASK 3: backend health panel | ✅/❌ | |
| TASK 3: check all parallel | ✅/❌ | |
| TASK 3: replace config form | ✅/❌ | |
| TASK 3: migrate form | ✅/❌ | |
| TASK 4: restore panel | ✅/❌ | |
| TASK 4: load completed jobs | ✅/❌ | |
| TASK 5: tab init handler | ✅/❌ | |
| TASK 6: collectDestConfig container | ✅/❌ | |
| Manual browser OK | ✅/❌ | |

## Vấn đề gặp phải
[...]

## Deviation so với prompt
[...]
```

---

**NHẮC NHỞ CUỐI:**
1. Tất cả HTML và JS phải match style của admin-ui.html hiện tại — không dùng class names tự đặt
2. Chạy verify script trước khi submit
3. Thực hiện manual verification trong browser — không được bỏ qua bước này
4. Backup tab ban đầu có `<section class="tab-panel" id="tab-backup">` — tất cả sections mới đều nằm bên trong tag này
