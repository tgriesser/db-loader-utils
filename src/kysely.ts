import type { Kysely, Selectable, SelectQueryBuilder } from 'kysely'
import type { Adapter, AggregateRequest, SelectJoinRequest, SelectRequest } from './core/adapter'
import { DBLoaderUtils } from './core/db-loader-utils'
import { createDefineScope } from './core/scope'
import type { DBLoaderUtilsOptions, QueryBuilderKind } from './core/types'

export * from './index'

export interface KyselyKind<DB> extends QueryBuilderKind<DB> {
  readonly builder: SelectQueryBuilder<DB, this['tables'] & keyof DB, {}>
}

export type SelectableTables<DB> = { [T in keyof DB]: Selectable<DB[T]> }

/** Typed `defineScope` for this adapter: `const scope = defineScope<DB>()` once, then `scope('posts', 'popular', (qb) => ...)`. */
export function defineScope<DB>() {
  return createDefineScope<KyselyKind<DB>>()
}

const identity = <T>(qb: T) => qb

export class KyselyAdapter implements Adapter {
  constructor(private readonly db: Kysely<any>) {}

  async select({ table, column, keys, columns, distinct, scope = identity }: SelectRequest) {
    const { ref } = this.db.dynamic
    const base = this.db.selectFrom(table).where(ref(`${table}.${column}`), 'in', keys)
    let qb: SelectQueryBuilder<any, any, any> = scope(base)
    qb = columns ? qb.select(columns.map((c) => ref(`${table}.${c}`))) : qb.selectAll(table)
    if (distinct) qb = qb.distinct()
    return qb.execute()
  }

  async selectJoin({ table, joinTable, on, column, keys, scope = identity }: SelectJoinRequest) {
    const { ref } = this.db.dynamic
    const [tableColumn, joinColumn] = on
    const base = this.db
      .selectFrom(table)
      .innerJoin(joinTable, `${joinTable}.${joinColumn}`, `${table}.${tableColumn}`)
      .where(ref(`${joinTable}.${column}`), 'in', keys)
    const qb: SelectQueryBuilder<any, any, any> = scope(base)
    return qb
      .selectAll(table)
      .select(ref(`${joinTable}.${column}`))
      .execute()
  }

  async aggregate({ table, column, keys, sums, count, scope = identity }: AggregateRequest) {
    const { ref } = this.db.dynamic
    const base = this.db.selectFrom(table).where(ref(`${table}.${column}`), 'in', keys)
    let qb: SelectQueryBuilder<any, any, any> = scope(base)
    qb = qb.groupBy(ref(`${table}.${column}`)).select(ref(`${table}.${column}`))
    if (count) qb = qb.select((eb) => eb.fn.countAll().as('count'))
    for (const col of sums) qb = qb.select((eb) => eb.fn.sum(ref(`${table}.${col}`)).as(col))
    return qb.execute()
  }
}

/**
 * `DB` is the same table map you give `Kysely<DB>`; loaders return `Selectable` rows.
 */
export class KyselyLoaderUtils<DB> extends DBLoaderUtils<SelectableTables<DB>, KyselyKind<DB>> {
  constructor(
    readonly db: Kysely<DB>,
    options?: DBLoaderUtilsOptions,
  ) {
    super(new KyselyAdapter(db), options)
  }
}

export default KyselyLoaderUtils
