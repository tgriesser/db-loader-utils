import type { Row } from '../adapter'

export type AnyScope = (x: any) => any

export type Dialect = 'postgres' | 'sqlite'

export type ReturningRequest = '*' | readonly string[]

export interface ConflictRequest {
  /** Empty means any conflict (only valid without `merge`). */
  columns: readonly string[]
  /** Omitted means `DO NOTHING`. */
  merge?: {
    /** Each set to its `excluded.` value. */
    excluded: readonly string[]
    /** Explicit values, applied over `excluded`. */
    set: Row
  }
  /** Write scope limiting which conflicting rows are updated. */
  where?: AnyScope
}

export interface WriteResult {
  count: number
  /** Empty unless `returning` was requested. */
  rows: Row[]
}

export interface TableAdapter<Executor = unknown> {
  /** The knex / kysely instance or transaction this adapter runs on. */
  readonly executor: Executor
  readonly dialect: Dialect
  readonly maxBindings: number
  /** Whether `executor` is a transaction. */
  readonly inTransaction: boolean
  /**
   * Settles when a transaction bound with `withTransaction` commits (resolves)
   * or rolls back (rejects). Undefined when the adapter can't observe that.
   */
  readonly committed?: Promise<unknown>

  select(req: {
    table: string
    where: Row
    /** Additional `(columns) IN (tuples)` filter. */
    whereIn?: { columns: readonly string[]; values: readonly unknown[][] }
    scope?: AnyScope
    limit?: number
  }): Promise<Row[]>
  count(req: { table: string; where: Row; scope?: AnyScope }): Promise<number>
  insert(req: {
    table: string
    rows: readonly Row[]
    returning?: ReturningRequest
    conflict?: ConflictRequest
  }): Promise<Row[]>
  /** With `captureBefore` (Postgres only), `before` holds the matched rows as they were. */
  update(req: {
    table: string
    where: Row
    set: Row
    scope?: AnyScope
    returning?: ReturningRequest
    captureBefore?: boolean
  }): Promise<WriteResult & { before?: Row[] }>
  delete(req: {
    table: string
    where: Row
    scope?: AnyScope
    returning?: ReturningRequest
  }): Promise<WriteResult>
  /**
   * One statement updating each row matched on `keys` with its own values.
   * Every row has exactly `columns`; `set` holds extra values shared by all rows.
   */
  updateMany(req: {
    table: string
    keys: readonly string[]
    columns: readonly string[]
    rows: readonly Row[]
    set: Row
    returning?: ReturningRequest
  }): Promise<WriteResult>
  transaction<R>(fn: (adapter: TableAdapter<Executor>) => Promise<R>): Promise<R>
}
