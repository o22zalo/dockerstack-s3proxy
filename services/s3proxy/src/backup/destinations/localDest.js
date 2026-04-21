import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs'
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

  async * listKeys(prefix = '') {
    const baseDir = join(this.rootDir, this.prefix)
    const walk = (dir, relativeRoot = '') => {
      const entries = readdirSync(dir, { withFileTypes: true })
      const results = []
      for (const entry of entries) {
        const relative = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name
        const fullPath = join(dir, entry.name)
        if (entry.isDirectory()) {
          results.push(...walk(fullPath, relative))
        } else {
          results.push(relative)
        }
      }
      return results
    }
    if (!existsSync(baseDir)) return
    for (const key of walk(baseDir)) {
      if (prefix && !key.startsWith(prefix)) continue
      yield { key, etag: '', size: statSync(join(baseDir, key)).size }
    }
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
