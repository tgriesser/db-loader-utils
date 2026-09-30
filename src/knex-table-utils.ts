import type { Knex } from 'knex'
import type { Row } from './core/adapter'
import type {
  ConflictRequest,
  Dialect,
  ReturningRequest,
  TableAdapter,
  WriteResult,
} from './core/table/adapter'
import { TableUtils } from './core/table/table-utils'
import type { TableKind, TableUtilsOptions } from './core/table/types'

export * from './core/table/exports'

export interface KnexTableKind extends TableKind {
  readonly readBuilder: Knex.QueryBuilder
  readonly writeScope: (qb: Knex.QueryBuilder) => Knex.QueryBuilder
  readonly expression: Knex.Raw | Knex.Ref<string, any>
  readonly executor: Knex
}

/**
 * Resolves each table's select / insert / update rows. A plain row type inserts as
 * `Partial<Row>`, like knex; use `Knex.CompositeTableType` for precise insert types.
 */
export type KnexTables<DB> = {
  [T in keyof DB & string]: {
    select: Knex.ResolveTableType<DB[T], 'base'>
    insert: DB[T] extends Knex.CompositeTableType<{}>
      ? Knex.ResolveTableType<DB[T], 'insert'>
      : Partial<DB[T]>
    update: Partial<Knex.ResolveTableType<DB[T], 'update'>>
  }
}

export type KnexTableUtilsOptions<DB> = TableUtilsOptions<
  KnexTables<DB>,
  KnexTableKind['expression']
>

const identity = <T>(qb: T) => qb

/** Marks which half of the before/after union a captured row came from. */
const BEFORE_FLAG = 'tableutilsbefore'

const MAX_BINDINGS: Record<Dialect, number> = { postgres: 60_000, sqlite: 30_000 }

export class KnexTableAdapter implements TableAdapter<Knex> {
  readonly dialect: Dialect
  readonly maxBindings: number
  readonly inTransaction: boolean

  constructor(
    readonly executor: Knex,
    readonly committed?: Promise<unknown>,
  ) {
    this.dialect = dialectOf(executor.client.dialect)
    this.maxBindings = MAX_BINDINGS[this.dialect]
    this.inTransaction = executor.isTransaction === true
  }

  async select({
    table,
    where,
    whereIn,
    scope = identity,
    limit,
  }: Parameters<TableAdapter['select']>[0]) {
    const qb = this.executor(table).select(`${table}.*`).where(qualify(table, where))
    if (whereIn) {
      const cols = whereIn.columns.map((c) => `${table}.${c}`)
      if (cols.length === 1) qb.whereIn(cols[0]!, whereIn.values.map((v) => v[0]) as any[])
      else qb.whereIn(cols, whereIn.values as any[][])
    }
    if (limit) qb.limit(limit)
    return scope(qb)
  }

  async count({ table, where, scope = identity }: Parameters<TableAdapter['count']>[0]) {
    const qb: Knex.QueryBuilder = scope(this.executor(table).where(qualify(table, where)))
    const [row] = await qb.clearSelect().clearOrder().count({ count: '*' })
    return Number(row?.count ?? 0)
  }

  async insert({ table, rows, returning, conflict }: Parameters<TableAdapter['insert']>[0]) {
    let qb: Knex.QueryBuilder = this.executor(table).insert(rows)
    if (conflict) qb = this.onConflict(qb, conflict)
    if (!returning) {
      await qb
      return []
    }
    return qb.returning(returning === '*' ? '*' : [...returning]) as Promise<Row[]>
  }

  private onConflict(qb: Knex.QueryBuilder, { columns, merge, where }: ConflictRequest) {
    const oc = columns.length ? qb.onConflict([...columns]) : qb.onConflict()
    if (!merge) return oc.ignore()
    const set: Row = {}
    for (const c of merge.excluded) set[c] = this.executor.ref(`excluded.${c}`)
    const merged = oc.merge({ ...set, ...merge.set })
    return where ? where(merged) : merged
  }

  async update({
    table,
    where,
    set,
    scope = identity,
    returning,
    captureBefore,
  }: Parameters<TableAdapter['update']>[0]) {
    const k = this.executor
    const w = qualify(table, where)
    if (captureBefore) {
      // One statement: both CTEs read the same snapshot, so `before` holds the pre-update rows.
      const before = scope(k(table).select(`${table}.*`).where(w).forUpdate())
      const after = scope(k(table).where(w).update(set)).returning('*')
      const rows: Row[] = await k
        .with('tu_before', before)
        .with('tu_after', after)
        .select('*', k.raw('true as ??', [BEFORE_FLAG]))
        .from('tu_before')
        .unionAll(k.select('*', k.raw('false as ??', [BEFORE_FLAG])).from('tu_after'))
      return splitBefore(rows)
    }
    const qb: Knex.QueryBuilder = scope(k(table).where(w).update(set))
    if (returning) qb.returning(returning === '*' ? '*' : [...returning])
    return this.write(qb, returning)
  }

  async delete({
    table,
    where,
    scope = identity,
    returning,
  }: Parameters<TableAdapter['delete']>[0]) {
    const qb: Knex.QueryBuilder = scope(this.executor(table).where(qualify(table, where)))
    if (!returning) return this.write(qb.del())
    if (this.dialect !== 'sqlite') {
      return this.write(qb.del(returning === '*' ? '*' : [...returning]), returning)
    }
    // knex's SQLite compiler drops RETURNING from deletes, though SQLite supports it.
    const { sql, bindings } = qb.del().toSQL()
    const cols = returning === '*' ? '*' : returning.map(() => '??').join(', ')
    const ids = returning === '*' ? [] : returning
    return this.write(
      this.executor.raw(`${sql} returning ${cols}`, [...bindings, ...ids]),
      returning,
    )
  }

  async updateMany({
    table,
    keys,
    columns,
    rows,
    set,
    returning,
  }: Parameters<TableAdapter['updateMany']>[0]) {
    const k = this.executor
    // The first, empty branch selects the real columns, so the database types every
    // value from its column rather than guessing from the bound parameter.
    const values = k(table)
      .select(columns.map((c) => `${table}.${c}`))
      .whereRaw('false')
      .unionAll(rows.map((r) => k.select(columns.map((c) => k.raw('?', [r[c] as Knex.Value])))))
    const toSet = columns.filter((c) => !keys.includes(c))
    let qb: Knex.QueryBuilder
    if (this.dialect === 'postgres') {
      const update: Row = {}
      for (const c of toSet) update[c] = k.ref(`tu_values.${c}`)
      qb = k
        .with('tu_values', values)
        .from(table)
        .updateFrom('tu_values')
        .update({ ...update, ...set })
      for (const key of keys) qb.where(`${table}.${key}`, k.ref(`tu_values.${key}`))
      if (returning) {
        qb.returning(returning === '*' ? `${table}.*` : returning.map((c) => `${table}.${c}`))
      }
    } else {
      // knex only compiles UPDATE ... FROM for Postgres; correlated subqueries work elsewhere.
      const match = (qb: Knex.QueryBuilder) => {
        for (const key of keys) qb.where(`tu_values.${key}`, k.ref(`${table}.${key}`))
        return qb
      }
      const update: Row = {}
      for (const c of toSet) update[c] = match(k('tu_values').select(`tu_values.${c}`))
      qb = k
        .with('tu_values', values)
        .from(table)
        .update({ ...update, ...set })
        .whereExists(match(k('tu_values').select(k.raw('1'))))
      if (returning) qb.returning(returning === '*' ? '*' : [...returning])
    }
    return this.write(qb, returning)
  }

  async transaction<R>(fn: (adapter: TableAdapter<Knex>) => Promise<R>): Promise<R> {
    return this.executor.transaction((trx) => fn(new KnexTableAdapter(trx)))
  }

  /** Runs an update / delete whose `returning`, if any, is already set. */
  private async write(
    qb: Knex.QueryBuilder | Knex.Raw,
    returning?: ReturningRequest,
  ): Promise<WriteResult> {
    if (!returning) return { count: Number(await qb), rows: [] }
    const rows: Row[] = await qb
    return { count: rows.length, rows }
  }
}

/**
 * Table-bound queries and writes over knex. `DB` maps table name to row type, or to
 * `Knex.CompositeTableType<Select, Insert, Update>`.
 */
export class KnexTableUtils<DB> extends TableUtils<KnexTables<DB>, KnexTableKind> {
  constructor(knex: Knex, options?: KnexTableUtilsOptions<DB>) {
    super(new KnexTableAdapter(knex), options)
  }

  /** The knex instance, or the transaction when bound to one. */
  get knex(): Knex {
    return this.adapter.executor
  }

  /** A copy bound to `trx`. Hooks wait for `trx` to commit and are dropped if it rolls back. */
  withTransaction(trx: Knex.Transaction): this {
    return this.bind(new KnexTableAdapter(trx, trx.executionPromise))
  }
}

export default KnexTableUtils

function dialectOf(dialect: string): Dialect {
  if (dialect === 'postgresql') return 'postgres'
  // Covers both the sqlite3 and better-sqlite3 clients.
  if (dialect.startsWith('sqlite')) return 'sqlite'
  throw new Error(`knex-table-utils supports Postgres and SQLite, not "${dialect}"`)
}

function qualify(table: string, where: Row): Row {
  const out: Row = {}
  for (const [k, v] of Object.entries(where)) out[`${table}.${k}`] = v
  return out
}

function splitBefore(rows: Row[]): WriteResult & { before: Row[] } {
  const before: Row[] = []
  const after: Row[] = []
  for (const { [BEFORE_FLAG]: flag, ...row } of rows) (flag ? before : after).push(row)
  return { count: after.length, rows: after, before }
}
