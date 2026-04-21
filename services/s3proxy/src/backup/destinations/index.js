import { LocalDestination } from './localDest.js'
import { MockHttpDestination } from './mockDest.js'
import { S3Destination } from './s3Dest.js'

export function createDestination(type, config = {}) {
  switch (type) {
    case 'local':
      return new LocalDestination(config)
    case 'mock':
      return new MockHttpDestination(config)
    case 's3':
      return new S3Destination(config)
    default:
      throw new Error(`Unknown destination type: ${type}`)
  }
}
