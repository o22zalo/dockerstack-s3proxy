import { createWriteStream, mkdirSync } from 'fs'
import { dirname } from 'path'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)

export class ZipDestination {
  constructor({ outputStream, outputPath, prefix = '', compression = 'deflate' } = {}) {
    this.prefix = prefix
    this.compression = compression

    if (outputStream) {
      this.outputStream = outputStream
    } else if (outputPath) {
      mkdirSync(dirname(outputPath), { recursive: true })
      this.outputStream = createWriteStream(outputPath)
    } else {
      throw new Error('zipDest requires outputStream or outputPath')
    }

    const archiver = require('archiver')
    this.archive = archiver('zip', {
      zlib: { level: compression === 'store' ? 0 : 6 },
    })

    this.archive.pipe(this.outputStream)

    this._finalized = false
    this._keys = new Map()

    this.archive.on('error', (err) => {
      this._archiveError = err
    })
  }

  async upload({ stream, key, size, signal }) {
    if (this._finalized) throw new Error('ZipDestination already finalized')
    if (this._archiveError) throw this._archiveError

    const entryName = `${this.prefix}${key}`.replace(/^\//, '')

    await new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('aborted'))
      const onAbort = () => {
        this.archive.abort()
        reject(new Error('aborted'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      this.archive.append(stream, { name: entryName, store: this.compression === 'store' })
      this.archive.once('entry', (entry) => {
        signal?.removeEventListener('abort', onAbort)
        this._keys.set(key, { size: entry.stats?.size ?? size ?? 0 })
        resolve()
      })
      stream.on('error', (err) => {
        signal?.removeEventListener('abort', onAbort)
        reject(err)
      })
    })

    return {
      key: entryName,
      location: `zip://${entryName}`,
      etag: '',
    }
  }

  async finalize() {
    if (this._finalized) return
    this._finalized = true
    await this.archive.finalize()
    await new Promise((resolve, reject) => {
      this.outputStream.on('finish', resolve)
      this.outputStream.on('error', reject)
      if (this.outputStream.writableEnded) resolve()
    })
  }

  async read(_key) { throw new Error('ZipDestination does not support read()') }
  async exists(key) { return this._keys.has(key) }
  async * listKeys(prefix = '') {
    for (const [key, meta] of this._keys) {
      if (!prefix || key.startsWith(prefix)) yield { key, etag: '', size: meta.size }
    }
  }
  async delete(_key) { throw new Error('ZipDestination does not support delete()') }
  async getMetadata(key) {
    const meta = this._keys.get(key)
    if (!meta) throw new Error(`key not found in zip: ${key}`)
    return { etag: '', size: meta.size, contentType: 'application/octet-stream' }
  }
}
