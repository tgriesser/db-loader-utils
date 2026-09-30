import { PGlite } from '@electric-sql/pglite'
import knexFactory, { type Knex } from 'knex'
import ClientPGLite from 'knex-pglite'
import { expect, it } from 'vitest'
import { defineScope } from '../src/knex'
import { KnexTableUtils } from '../src/knex-table-utils'
import { runTableSuite, schema, type TableHarness, type Utils } from './table-suite'

const snake = (s: string) => s.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)
const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
const camelRow = (row: unknown) =>
  row && typeof row === 'object' && !(row instanceof Date)
    ? Object.fromEntries(Object.entries(row).map(([k, v]) => [camel(k), v]))
    : row

function harness(dialect: TableHarness['dialect'], config: Knex.Config): TableHarness {
  const knex = knexFactory({
    ...config,
    wrapIdentifier: (value, orig) => orig(snake(value)),
    postProcessResponse: (result) =>
      Array.isArray(result)
        ? result.map(camelRow)
        : // knex-pglite hands back the raw result for a delete where knex's pg client returns the count.
          result?.command === 'DEL'
          ? result.rowCount
          : result,
  })
  let queries = 0
  knex.on('query', () => queries++)
  return {
    dialect,
    externalCommit: true,
    async setup() {
      for (const stmt of schema(dialect)) await knex.raw(stmt)
    },
    teardown: () => knex.destroy(),
    make: (options) => new KnexTableUtils<any>(knex, options) as Utils,
    raw: (sql) => knex.raw(sql),
    viewsAbove: (n) => (qb: Knex.QueryBuilder) => qb.where('posts.views', '>', n),
    defineScope: (table, name, scope) => defineScope<any>()(table, name, scope),
    external: (utils, fn) =>
      knex.transaction((trx) => fn((utils as KnexTableUtils<any>).withTransaction(trx) as Utils)),
    time: (v) => (v instanceof Date ? v.getTime() : Date.parse(String(v))),
    queries: () => queries,
  }
}

runTableSuite(
  'knex-table-utils (sqlite)',
  harness('sqlite', {
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 },
  }),
)

runTableSuite(
  'knex-table-utils (postgres)',
  harness('postgres', { client: ClientPGLite, connection: { pglite: new PGlite() } as any }),
)

it('throws for dialects other than Postgres and SQLite', () => {
  // No `connection`, so knex never loads the mysql driver.
  expect(() => new KnexTableUtils(knexFactory({ client: 'mysql2' }))).toThrow(
    'knex-table-utils supports Postgres and SQLite, not "mysql"',
  )
})
