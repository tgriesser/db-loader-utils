import type { Key } from './types'

export type Row = Record<string, unknown>

export type AnyScope = (qb: any) => any

export interface SelectRequest {
  table: string
  column: string
  keys: readonly Key[]
  /** Omitted means every column of `table`. */
  columns?: readonly string[]
  distinct?: boolean
  scope?: AnyScope
}

export interface SelectJoinRequest {
  table: string
  joinTable: string
  /** `[column on table, column on joinTable]` */
  on: readonly [string, string]
  /** Column on `joinTable` the keys are matched against; also selected. */
  column: string
  keys: readonly Key[]
  scope?: AnyScope
}

export interface AggregateRequest {
  table: string
  column: string
  keys: readonly Key[]
  /** Columns to `SUM`, each aliased to its own name. */
  sums: readonly string[]
  /** Whether to include `COUNT(*)` aliased as `count`. */
  count: boolean
  scope?: AnyScope
}

export interface Adapter {
  select(req: SelectRequest): Promise<Row[]>
  selectJoin(req: SelectJoinRequest): Promise<Row[]>
  /** One row per distinct `column` value, grouped by it. */
  aggregate(req: AggregateRequest): Promise<Row[]>
}
