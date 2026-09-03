import type { Key } from './types'

export class NotFoundError extends Error {
  constructor(
    readonly table: string,
    readonly column: string,
    readonly key: Key,
  ) {
    super(`No row in "${table}" where "${column}" = ${JSON.stringify(key)}`)
    this.name = 'NotFoundError'
  }
}
