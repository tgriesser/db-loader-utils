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

export class RowNotFoundError extends Error {
  constructor(
    readonly table: string,
    readonly where: Record<string, unknown>,
  ) {
    super(`No row in "${table}" matching ${JSON.stringify(where)}`)
    this.name = 'RowNotFoundError'
  }
}
