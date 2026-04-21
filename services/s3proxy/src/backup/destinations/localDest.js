import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync, statSync } from 'fs'
import { dirname, join } from 'path'
import { pipeline } from 'stream/promises'

export class LocalDestination {
  constructor({ rootDir = '/backup-data', prefix = '' } = {}) {
    this.rootDir = rootDir
    this.prefix = prefix
  }

  async upload({ stream, key }) {
    const relativePath = join(this.prefix, key)
    const fullPath = join(this.rootDir, relativePath)
    mkdirSync(dirname(fullPath), { recursive: true })
    await pipeline(stream, createWriteStream(fullPath))
    return {
      location: `file://${fullPath}`,
      etag: '',
      key: relativePath,
    }
  }

  async read(key) {
    return createReadStream(join(this.rootDir, this.prefix, key))
  }

  async exists(key) {
    return existsSync(join(this.rootDir, this.prefix, key))
  }

  async * listKeys(_prefix = '') {
    // MVP: local destination currently does not recursively enumerate.
  }

  async delete(key) {
    rmSync(join(this.rootDir, this.prefix, key), { force: true })
  }

  async getMetadata(key) {
    const stats = statSync(join(this.rootDir, this.prefix, key))
    return {
      etag: '',
      size: stats.size,
      contentType: 'application/octet-stream',
    }
  }
}
