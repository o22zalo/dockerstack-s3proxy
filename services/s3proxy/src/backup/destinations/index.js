import { LocalDestination } from './localDest.js'
import { MockHttpDestination } from './mockDest.js'
import { S3Destination } from './s3Dest.js'
import { ZipDestination } from './zipDest.js'
import { GDriveDestination } from './gdriveDest.js'
import { OneDriveDestination } from './onedriveDest.js'

export function createDestination(type, config = {}) {
  switch (type) {
    case 'local':
      return new LocalDestination(config)
    case 'mock':
      return new MockHttpDestination(config)
    case 's3':
      return new S3Destination(config)
    case 'zip':
      return new ZipDestination(config)
    case 'gdrive':
      return new GDriveDestination(config)
    case 'onedrive':
      return new OneDriveDestination(config)
    default:
      throw new Error(`Unknown destination type: ${type}. Valid: local, s3, zip, gdrive, onedrive, mock`)
  }
}
