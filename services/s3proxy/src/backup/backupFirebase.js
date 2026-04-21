import config from '../config.js'

function normalizePath(path) {
  const value = String(path ?? '').trim()
  if (!value || value === '/') return ''
  return value.replace(/^\/+|\/+$/g, '')
}

function buildUrl(path) {
  const root = String(config.BACKUP_RTDB_URL || '').trim()
  if (!root) return null

  const normalized = normalizePath(path)
  const [baseWithoutQuery, query = ''] = root.split('?')
  const cleanBase = baseWithoutQuery.replace(/\/$/, '')

  const suffix = normalized ? `/${normalized}` : ''
  const queryText = query ? `?${query}` : ''
  return `${cleanBase}${suffix}.json${queryText}`
}

export async function backupRtdbPatch(path, value) {
  const url = buildUrl(path)
  if (!url) return null
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value ?? {}),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`backup RTDB PATCH ${path} failed: ${res.status} ${text}`)
  }
  return res.json().catch(() => null)
}

export async function backupRtdbSet(path, value) {
  const url = buildUrl(path)
  if (!url) return null
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value ?? null),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`backup RTDB PUT ${path} failed: ${res.status} ${text}`)
  }
  return res.json().catch(() => null)
}
