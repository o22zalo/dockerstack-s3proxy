const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'
const CHUNK_SIZE = 10 * 1024 * 1024

export class OneDriveDestination {
  constructor({ accessToken, driveId, folderId, prefix = '' } = {}) {
    if (!accessToken) throw new Error('onedrive destination requires accessToken')
    if (!folderId) throw new Error('onedrive destination requires folderId')
    this.accessToken = accessToken
    this.driveId = driveId
    this.folderId = folderId
    this.prefix = prefix
    this._keyToItemId = new Map()
  }

  _headers(extra = {}) {
    return { Authorization: `Bearer ${this.accessToken}`, ...extra }
  }

  _itemPath(key) {
    const entryName = `${this.prefix}${key}`.replace(/^\//, '').replace(/\//g, '_')
    const base = this.driveId ? `${GRAPH_BASE}/drives/${this.driveId}` : `${GRAPH_BASE}/me/drive`
    return `${base}/items/${this.folderId}:/${encodeURIComponent(entryName)}:`
  }

  async upload({ stream, key, contentType = 'application/octet-stream', signal }) {
    const entryName = `${this.prefix}${key}`.replace(/^\//, '').replace(/\//g, '_')
    const itemPath = this._itemPath(key)

    const sessionRes = await fetch(`${itemPath}/createUploadSession`, {
      method: 'POST',
      headers: this._headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        item: { '@microsoft.graph.conflictBehavior': 'replace', name: entryName },
      }),
      signal,
    })

    if (!sessionRes.ok) {
      const text = await sessionRes.text().catch(() => '')
      throw new Error(`OneDrive createUploadSession failed ${sessionRes.status}: ${text}`)
    }

    const { uploadUrl } = await sessionRes.json()
    if (!uploadUrl) throw new Error('OneDrive did not return uploadUrl')

    const chunks = []
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    const body = Buffer.concat(chunks)
    const totalSize = body.length

    let offset = 0
    let lastResult = null

    while (offset < totalSize) {
      if (signal?.aborted) throw new Error('aborted')
      const end = Math.min(offset + CHUNK_SIZE, totalSize)
      const chunkBody = body.subarray(offset, end)

      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Length': String(chunkBody.length),
          'Content-Range': `bytes ${offset}-${end - 1}/${totalSize}`,
        },
        body: chunkBody,
        signal,
      })

      if (putRes.status !== 202 && putRes.status !== 201 && putRes.status !== 200) {
        const text = await putRes.text().catch(() => '')
        throw new Error(`OneDrive chunk upload failed ${putRes.status}: ${text}`)
      }

      if (putRes.status === 201 || putRes.status === 200) {
        lastResult = await putRes.json()
      }

      offset = end
    }

    const itemId = lastResult?.id || ''
    this._keyToItemId.set(key, itemId)

    return {
      key: entryName,
      location: `onedrive://${this.folderId}/${itemId}`,
      etag: lastResult?.eTag?.replace(/"/g, '') || itemId,
    }
  }

  async read(key) {
    const itemId = this._keyToItemId.get(key)
    if (!itemId) throw new Error(`OneDrive: itemId not found for key: ${key}`)
    const base = this.driveId ? `${GRAPH_BASE}/drives/${this.driveId}` : `${GRAPH_BASE}/me/drive`
    const res = await fetch(`${base}/items/${itemId}/content`, { headers: this._headers() })
    if (!res.ok) throw new Error(`OneDrive read failed ${res.status}`)
    return res.body
  }

  async exists(key) { return this._keyToItemId.has(key) }

  async * listKeys(prefix = '') {
    const base = this.driveId ? `${GRAPH_BASE}/drives/${this.driveId}` : `${GRAPH_BASE}/me/drive`
    let url = `${base}/items/${this.folderId}/children?$select=id,name,size,eTag&$top=100`
    do {
      const res = await fetch(url, { headers: this._headers() })
      if (!res.ok) break
      const data = await res.json()
      for (const item of data.value || []) {
        const k = item.name || ''
        if (!prefix || k.startsWith(prefix)) {
          yield { key: k, etag: item.eTag?.replace(/"/g, '') || item.id, size: Number(item.size || 0) }
        }
      }
      url = data['@odata.nextLink'] || null
    } while (url)
  }

  async delete(key) {
    const itemId = this._keyToItemId.get(key)
    if (!itemId) return
    const base = this.driveId ? `${GRAPH_BASE}/drives/${this.driveId}` : `${GRAPH_BASE}/me/drive`
    await fetch(`${base}/items/${itemId}`, { method: 'DELETE', headers: this._headers() })
    this._keyToItemId.delete(key)
  }

  async getMetadata(key) {
    const itemId = this._keyToItemId.get(key)
    if (!itemId) throw new Error(`OneDrive: itemId not found for key: ${key}`)
    const base = this.driveId ? `${GRAPH_BASE}/drives/${this.driveId}` : `${GRAPH_BASE}/me/drive`
    const res = await fetch(`${base}/items/${itemId}?$select=id,size,file,eTag`, { headers: this._headers() })
    if (!res.ok) throw new Error(`OneDrive getMetadata failed ${res.status}`)
    const data = await res.json()
    return {
      etag: data.eTag?.replace(/"/g, '') || data.id,
      size: Number(data.size || 0),
      contentType: data.file?.mimeType || 'application/octet-stream',
    }
  }
}
