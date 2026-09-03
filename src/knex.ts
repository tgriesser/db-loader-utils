import type { Knex } from 'knex'
import type { Adapter, AggregateRequest, SelectJoinRequest, SelectRequest } from './core/adapter'
import { DBLoaderUtils } from './core/db-loader-utils'
import { createDefineScope } from './core/scope'
import type { DBLoaderUtilsOptions, QueryBuilderKind } from './core/types'

export * from './index'

export interface KnexKind<DB> extends QueryBuilderKind<DB> {
  readonly builder: Knex.QueryBuilder
}

/** Typed `defineScope` for this adapter: `const scope = defineScope<DB>()` once, then `scope('posts', 'popular', (qb) => ...)`. */
export function defineScope<DB>() {
  return createDefineScope<KnexKind<DB>>()
}

const identity = <T>(qb: T) => qb

export class KnexAdapter implements Adapter {
  constructor(private readonly knex: Knex) {}

  async select({ table, column, keys, columns, distinct, scope = identity }: SelectRequest) {
    const cols = columns ? columns.map((c) => `${table}.${c}`) : [`${table}.*`]
    const qb = this.knex(table).whereIn(`${table}.${column}`, Array.from(keys))
    return scope(distinct ? qb.distinct(cols) : qb.select(cols))
  }

  async selectJoin({ table, joinTable, on, column, keys, scope = identity }: SelectJoinRequest) {
    const [tableColumn, joinColumn] = on
    const qb = this.knex(table)
      .select(`${table}.*`, `${joinTable}.${column}`)
      .innerJoin(joinTable, `${joinTable}.${joinColumn}`, `${table}.${tableColumn}`)
      .whereIn(`${joinTable}.${column}`, Array.from(keys))
    return scope(qb)
  }

  async aggregate({ table, column, keys, sums, count, scope = identity }: AggregateRequest) {
    const qb = this.knex(table)
      .select(`${table}.${column}`)
      .whereIn(`${table}.${column}`, Array.from(keys))
      .groupBy(`${table}.${column}`)
    if (count) qb.count({ count: '*' })
    for (const col of sums) qb.sum({ [col]: `${table}.${col}` })
    return scope(qb)
  }
}

/**
 * `DB` maps table name to row type, e.g. `{ users: { id: number; name: string } }`.
 */
export class KnexLoaderUtils<DB> extends DBLoaderUtils<DB, KnexKind<DB>> {
  constructor(
    readonly knex: Knex,
    options?: DBLoaderUtilsOptions,
  ) {
    super(new KnexAdapter(knex), options)
  }
}

export default KnexLoaderUtils
