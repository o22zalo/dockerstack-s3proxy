export class MockHttpDestination {
  constructor({ endpoint, token = '', prefix = '' } = {}) {
    this.endpoint = String(endpoint || '').replace(/\/$/, '')
    this.token = token
    this.prefix = prefix
  }

  async upload({ stream, key, contentType, signal }) {
    if (!this.endpoint) {
      throw new Error('mock destination requires endpoint')
    }

    const targetKey = `${this.prefix}${key}`
    const res = await fetch(`${this.endpoint}/upload/${encodeURIComponent(targetKey)}`, {
      method: 'PUT',
      headers: {
        'content-type': contentType || 'application/octet-stream',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: stream,
      duplex: 'half',
      signal,
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`mock upload failed ${res.status}: ${text}`)
    }

    const location = res.headers.get('x-mock-location') || `${this.endpoint}/objects/${encodeURIComponent(targetKey)}`
    return { location, etag: res.headers.get('etag') || '', key: targetKey }
  }
}
