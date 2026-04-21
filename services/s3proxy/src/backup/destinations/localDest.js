import { createWriteStream, mkdirSync } from 'fs'
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
}
