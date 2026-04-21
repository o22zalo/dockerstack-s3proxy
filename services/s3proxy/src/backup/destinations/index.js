import { LocalDestination } from './localDest.js'
import { MockHttpDestination } from './mockDest.js'

export function createDestination(type, config = {}) {
  switch (type) {
    case 'local':
      return new LocalDestination(config)
    case 'mock':
      return new MockHttpDestination(config)
    default:
      throw new Error(`Unknown destination type: ${type}`)
  }
}
