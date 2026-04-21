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

  async read(_key) { throw new Error('mock destination read() is not implemented') }
  async exists(_key) { throw new Error('mock destination exists() is not implemented') }
  async * listKeys(_prefix = '') { }
  async delete(_key) { throw new Error('mock destination delete() is not implemented') }
  async getMetadata(_key) { throw new Error('mock destination getMetadata() is not implemented') }
}
