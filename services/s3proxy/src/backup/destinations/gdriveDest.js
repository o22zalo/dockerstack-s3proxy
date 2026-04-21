const GDRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3/files'
const GDRIVE_FILES_BASE = 'https://www.googleapis.com/drive/v3/files'

export class GDriveDestination {
  constructor({ accessToken, folderId, prefix = '', tokenRefreshFn = null } = {}) {
    if (!accessToken) throw new Error('gdrive destination requires accessToken')
    if (!folderId) throw new Error('gdrive destination requires folderId')
    this.accessToken = accessToken
    this.folderId = folderId
    this.prefix = prefix
    this.tokenRefreshFn = tokenRefreshFn
    this._keyToFileId = new Map()
  }

  static extractFileId(dstLocation) {
    if (!dstLocation) return null
    const match = String(dstLocation).match(/^gdrive:\/\/[^/]+\/(.+)$/)
    return match ? match[1] : null
  }

  async _getToken() {
    if (this.tokenRefreshFn) {
      this.accessToken = await this.tokenRefreshFn(this.accessToken)
    }
    return this.accessToken
  }

  async upload({ stream, key, contentType = 'application/octet-stream', size, signal }) {
    const token = await this._getToken()
    const entryName = `${this.prefix}${key}`.replace(/^\//, '')
    const fileName = entryName.replace(/\//g, '_')

    const initRes = await fetch(`${GDRIVE_UPLOAD_BASE}?uploadType=resumable`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Upload-Content-Type': contentType,
        ...(size ? { 'X-Upload-Content-Length': String(size) } : {}),
      },
      body: JSON.stringify({
        name: fileName,
        parents: [this.folderId],
        description: key,
      }),
      signal,
    })

    if (!initRes.ok) {
      const text = await initRes.text().catch(() => '')
      throw new Error(`GDrive initiate upload failed ${initRes.status}: ${text}`)
    }

    const uploadUrl = initRes.headers.get('location')
    if (!uploadUrl) throw new Error('GDrive did not return upload URL')

    const uploadRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        ...(size ? { 'Content-Length': String(size) } : {}),
      },
      body: stream,
      duplex: 'half',
      signal,
    })

    if (!uploadRes.ok && uploadRes.status !== 308) {
      const text = await uploadRes.text().catch(() => '')
      throw new Error(`GDrive upload failed ${uploadRes.status}: ${text}`)
    }

    const data = await uploadRes.json().catch(() => ({}))
    const fileId = data.id || ''
    this._keyToFileId.set(key, fileId)

    return {
      key: entryName,
      location: `gdrive://${this.folderId}/${fileId}`,
      etag: fileId,
    }
  }

  async _findFileIdByDescription(key) {
    const token = await this._getToken()
    const params = new URLSearchParams({
      q: `'${this.folderId}' in parents and description='${key}' and trashed=false`,
      fields: 'files(id,description)',
      pageSize: '1',
    })

    try {
      const res = await fetch(`${GDRIVE_FILES_BASE}?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) return null
      const data = await res.json()
      const file = data.files?.[0]
      if (file?.id) {
        this._keyToFileId.set(key, file.id)
        return file.id
      }
    } catch {
      // ignore
    }
    return null
  }

  async read(key, { dstLocation = null } = {}) {
    const token = await this._getToken()
    let fileId = this._keyToFileId.get(key)
    if (!fileId && dstLocation) fileId = GDriveDestination.extractFileId(dstLocation)
    if (!fileId) fileId = await this._findFileIdByDescription(key)
    if (!fileId) throw new Error(`GDrive: fileId not found for key: ${key}. Provide dstLocation or ensure file exists.`)

    this._keyToFileId.set(key, fileId)
    const res = await fetch(`${GDRIVE_FILES_BASE}/${fileId}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) throw new Error(`GDrive read failed ${res.status}`)
    return res.body
  }

  async exists(key, { dstLocation = null } = {}) {
    if (this._keyToFileId.has(key)) return true
    if (dstLocation) {
      const fileId = GDriveDestination.extractFileId(dstLocation)
      if (fileId) {
        this._keyToFileId.set(key, fileId)
        return true
      }
    }
    const found = await this._findFileIdByDescription(key)
    return Boolean(found)
  }

  async * listKeys(prefix = '') {
    const token = await this._getToken()
    let pageToken
    do {
      const params = new URLSearchParams({
        q: `'${this.folderId}' in parents and trashed=false`,
        fields: 'nextPageToken,files(id,name,description,size)',
        pageSize: '100',
        ...(pageToken ? { pageToken } : {}),
      })
      const res = await fetch(`${GDRIVE_FILES_BASE}?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) break
      const data = await res.json()
      for (const file of data.files || []) {
        const originalKey = file.description || file.name
        if (!prefix || originalKey.startsWith(prefix)) {
          yield { key: originalKey, etag: file.id, size: Number(file.size || 0) }
        }
      }
      pageToken = data.nextPageToken
    } while (pageToken)
  }

  async delete(key) {
    const token = await this._getToken()
    const fileId = this._keyToFileId.get(key)
    if (!fileId) return
    await fetch(`${GDRIVE_FILES_BASE}/${fileId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    this._keyToFileId.delete(key)
  }

  async getMetadata(key, { dstLocation = null } = {}) {
    const token = await this._getToken()
    let fileId = this._keyToFileId.get(key)
    if (!fileId && dstLocation) fileId = GDriveDestination.extractFileId(dstLocation)
    if (!fileId) fileId = await this._findFileIdByDescription(key)
    if (!fileId) throw new Error(`GDrive: fileId not found for key: ${key}. Provide dstLocation or ensure file exists.`)

    this._keyToFileId.set(key, fileId)
    const res = await fetch(`${GDRIVE_FILES_BASE}/${fileId}?fields=id,size,mimeType`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) throw new Error(`GDrive getMetadata failed ${res.status}`)
    const data = await res.json()
    return {
      etag: data.id || '',
      size: Number(data.size || 0),
      contentType: data.mimeType || 'application/octet-stream',
    }
  }
}
