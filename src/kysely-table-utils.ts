import {
  PostgresAdapter,
  SqliteAdapter,
  type Expression,
  type ExpressionBuilder,
  type Insertable,
  type Kysely,
  type Selectable,
  type SelectQueryBuilder,
  type SqlBool,
  type Transaction,
  type Updateable,
} from 'kysely'
import type { Row } from './core/adapter'
import type {
  AnyScope,
  ConflictRequest,
  Dialect,
  TableAdapter,
  WriteResult,
} from './core/table/adapter'
import { TableUtils } from './core/table/table-utils'
import type { TableKind, TableUtilsOptions } from './core/table/types'

export * from './core/table/exports'

export interface KyselyTableKind<DB> extends TableKind {
  readonly readBuilder: SelectQueryBuilder<DB, this['tables'] & keyof DB, {}>
  /** Update, delete and conflict-merge builders differ in kysely, so write scopes are where-expressions. */
  readonly writeScope: (eb: ExpressionBuilder<DB, this['tables'] & keyof DB>) => Expression<SqlBool>
  readonly expression: Expression<any>
  readonly executor: Kysely<DB>
}

export type KyselyTables<DB> = {
  [T in keyof DB & string]: {
    select: Selectable<DB[T]>
    insert: Insertable<DB[T]>
    update: Updateable<DB[T]>
  }
}

export type KyselyTableUtilsOptions<DB> = TableUtilsOptions<
  KyselyTables<DB>,
  KyselyTableKind<DB>['expression']
>

type AnyDB = Kysely<any>
type AnyEB = ExpressionBuilder<any, any>

const identity = <T>(qb: T) => qb

/** Marks which half of the before/after union a captured row came from. */
const BEFORE_FLAG = 'tableutilsbefore'

const MAX_BINDINGS: Record<Dialect, number> = { postgres: 60_000, sqlite: 30_000 }

export class KyselyTableAdapter implements TableAdapter<AnyDB> {
  readonly dialect: Dialect
  readonly maxBindings: number
  readonly inTransaction: boolean

  constructor(
    readonly executor: AnyDB,
    readonly committed?: Promise<unknown>,
  ) {
    // `getExecutor` is marked internal, but it's the only route to the dialect adapter.
    const adapter = executor.getExecutor().adapter
    if (adapter instanceof PostgresAdapter) this.dialect = 'postgres'
    else if (adapter instanceof SqliteAdapter) this.dialect = 'sqlite'
    else {
      throw new Error(
        `kysely-table-utils supports Postgres and SQLite, not ${adapter.constructor.name}`,
      )
    }
    this.maxBindings = MAX_BINDINGS[this.dialect]
    this.inTransaction = executor.isTransaction
  }

  async select({
    table,
    where,
    whereIn,
    scope = identity,
    limit,
  }: Parameters<TableAdapter['select']>[0]) {
    const { ref } = this.executor.dynamic
    let qb: SelectQueryBuilder<any, any, any> = this.executor.selectFrom(table)
    if (Object.keys(where).length) qb = qb.where(this.whereExpr(table, where))
    if (whereIn) {
      const cols = whereIn.columns.map((c) => ref(`${table}.${c}`))
      qb = qb.where((eb) =>
        cols.length === 1
          ? eb(
              cols[0]!,
              'in',
              whereIn.values.map((v) => v[0]),
            )
          : eb.or(whereIn.values.map((v) => eb.and(cols.map((c, i) => eb(c, '=', v[i]))))),
      )
    }
    qb = scope(qb).selectAll(table)
    if (limit) qb = qb.limit(limit)
    return qb.execute()
  }

  async count({ table, where, scope = identity }: Parameters<TableAdapter['count']>[0]) {
    let qb: SelectQueryBuilder<any, any, any> = this.executor.selectFrom(table)
    if (Object.keys(where).length) qb = qb.where(this.whereExpr(table, where))
    const row = await scope(qb)
      .clearSelect()
      .clearOrderBy()
      .select((eb: AnyEB) => eb.fn.countAll().as('count'))
      .executeTakeFirst()
    return Number(row?.count ?? 0)
  }

  async insert({ table, rows, returning, conflict }: Parameters<TableAdapter['insert']>[0]) {
    let qb = this.executor.insertInto(table).values(rows as Row[])
    if (conflict) qb = qb.onConflict((oc) => onConflict(oc, conflict))
    if (!returning) {
      await qb.execute()
      return []
    }
    return (returning === '*' ? qb.returningAll() : qb.returning([...returning])).execute()
  }

  async update({
    table,
    where,
    set,
    scope,
    returning,
    captureBefore,
  }: Parameters<TableAdapter['update']>[0]) {
    const db = this.executor
    const whereExpr = this.writeWhere(table, where, scope)
    if (captureBefore) {
      // One statement: both CTEs read the same snapshot, so `before` holds the pre-update rows.
      const rows = await db
        .with('tu_before', (qc) => qc.selectFrom(table).selectAll().where(whereExpr).forUpdate())
        .with('tu_after', (qc) => qc.updateTable(table).set(set).where(whereExpr).returningAll())
        .selectFrom('tu_before')
        .selectAll()
        .select((eb) => eb.lit<boolean>(true).as(BEFORE_FLAG))
        .unionAll(
          db
            .selectFrom('tu_after')
            .selectAll()
            .select((eb) => eb.lit<boolean>(false).as(BEFORE_FLAG)),
        )
        .execute()
      return splitBefore(rows)
    }
    const qb = db.updateTable(table).set(set).where(whereExpr)
    if (!returning) {
      const result = await qb.executeTakeFirst()
      return { count: Number(result.numUpdatedRows), rows: [] }
    }
    return rowsResult(
      await (returning === '*' ? qb.returningAll() : qb.returning([...returning])).execute(),
    )
  }

  async delete({ table, where, scope, returning }: Parameters<TableAdapter['delete']>[0]) {
    const qb = this.executor.deleteFrom(table).where(this.writeWhere(table, where, scope))
    if (!returning) {
      const result = await qb.executeTakeFirst()
      return { count: Number(result.numDeletedRows), rows: [] }
    }
    return rowsResult(
      await (returning === '*' ? qb.returningAll() : qb.returning([...returning])).execute(),
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
    const db = this.executor
    const { ref } = db.dynamic
    // The first, empty branch selects the real columns, so the database types every
    // value from its column rather than guessing from the bound parameter. A VALUES
    // list wouldn't work: Postgres resolves its types (as text) before the union.
    const values = db
      .selectFrom(table)
      .select(columns.map((c) => ref(`${table}.${c}`)))
      .where((eb) => eb.lit(false))
      .unionAll(rows.map((r) => db.selectNoFrom((eb) => columns.map((c) => eb.val(r[c]).as(c)))))
    const toSet = columns.filter((c) => !keys.includes(c))
    const qb = db
      .with('tu_values', () => values)
      .updateTable(table)
      .from('tu_values')
      .set((eb) => ({
        ...Object.fromEntries(toSet.map((c) => [c, eb.ref(`tu_values.${c}`)])),
        ...set,
      }))
      .where((eb) =>
        eb.and(keys.map((k) => eb(ref(`${table}.${k}`), '=', eb.ref(`tu_values.${k}`)))),
      )
    if (!returning) {
      const result = await qb.executeTakeFirst()
      return { count: Number(result.numUpdatedRows), rows: [] }
    }
    // Postgres would also return the joined `tu_values` columns for an unqualified `*`;
    // SQLite rejects qualified names in RETURNING.
    const qualified = this.dialect === 'postgres'
    const cols =
      returning === '*' ? null : returning.map((c) => (qualified ? ref(`${table}.${c}`) : c))
    const withReturning = cols
      ? qb.returning(cols)
      : qualified
        ? qb.returningAll(table)
        : qb.returningAll()
    return rowsResult(await withReturning.execute())
  }

  async transaction<R>(fn: (adapter: TableAdapter<AnyDB>) => Promise<R>): Promise<R> {
    return this.executor.transaction().execute((trx) => fn(new KyselyTableAdapter(trx)))
  }

  private whereExpr(table: string, where: Row) {
    const { ref } = this.executor.dynamic
    return (eb: AnyEB) =>
      eb.and(
        Object.entries(where).map(([c, v]) =>
          v === null ? eb(ref(`${table}.${c}`), 'is', null) : eb(ref(`${table}.${c}`), '=', v),
        ),
      )
  }

  private writeWhere(table: string, where: Row, scope?: AnyScope) {
    const eq = this.whereExpr(table, where)
    return (eb: AnyEB) => {
      const parts: Expression<SqlBool>[] = []
      if (Object.keys(where).length) parts.push(eq(eb))
      if (scope) parts.push(scope(eb))
      return eb.and(parts)
    }
  }
}

function onConflict(oc: any, { columns, merge, where }: ConflictRequest) {
  const target = columns.length ? oc.columns([...columns]) : oc
  if (!merge) return target.doNothing()
  const update = target.doUpdateSet((eb: AnyEB) => ({
    ...Object.fromEntries(merge.excluded.map((c) => [c, eb.ref(`excluded.${c}`)])),
    ...merge.set,
  }))
  return where ? update.where(where) : update
}

function rowsResult(rows: Row[]): WriteResult {
  return { count: rows.length, rows }
}

function splitBefore(rows: Row[]): WriteResult & { before: Row[] } {
  const before: Row[] = []
  const after: Row[] = []
  for (const { [BEFORE_FLAG]: flag, ...row } of rows) (flag ? before : after).push(row)
  return { count: after.length, rows: after, before }
}

/**
 * Table-bound queries and writes over kysely. `DB` is the same table map you give
 * `Kysely<DB>`; rows come back `Selectable`, and inserts / updates take `Insertable` /
 * `Updateable`.
 */
export class KyselyTableUtils<DB> extends TableUtils<KyselyTables<DB>, KyselyTableKind<DB>> {
  constructor(db: Kysely<DB>, options?: KyselyTableUtilsOptions<DB>) {
    super(new KyselyTableAdapter(db as AnyDB) as TableAdapter<Kysely<DB>>, options)
  }

  /** The kysely instance, or the transaction when bound to one. */
  get db(): Kysely<DB> {
    return this.adapter.executor
  }

  /**
   * A copy bound to `trx`. kysely can't report when `trx` commits, so a write here that
   * would fire a hook throws; use `transaction()` for tables with hooks.
   */
  withTransaction(trx: Transaction<DB>): this {
    return this.bind(new KyselyTableAdapter(trx as AnyDB) as TableAdapter<Kysely<DB>>)
  }
}

export default KyselyTableUtils
