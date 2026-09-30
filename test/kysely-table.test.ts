import { PGlite } from '@electric-sql/pglite'
import Database from 'better-sqlite3'
import {
  CamelCasePlugin,
  Kysely,
  MysqlDialect,
  SqliteDialect,
  sql,
  type Dialect as KyselyDialect,
  type ExpressionBuilder,
} from 'kysely'
import { PGliteDialect } from 'kysely-pglite-dialect'
import { expect, it } from 'vitest'
import { defineScope } from '../src/kysely'
import { KyselyTableUtils } from '../src/kysely-table-utils'
import { runTableSuite, schema, type TableHarness, type Utils } from './table-suite'

function harness(dialect: TableHarness['dialect'], kyselyDialect: KyselyDialect): TableHarness {
  let queries = 0
  const db = new Kysely<any>({
    dialect: kyselyDialect,
    plugins: [new CamelCasePlugin()],
    log: (event) => {
      if (event.level === 'query') queries++
    },
  })
  return {
    dialect,
    externalCommit: false,
    async setup() {
      for (const stmt of schema(dialect)) await sql.raw(stmt).execute(db)
    },
    teardown: () => db.destroy(),
    make: (options) => new KyselyTableUtils<any>(db, options) as Utils,
    raw: (text) => sql.raw(text),
    viewsAbove: (n) => (eb: ExpressionBuilder<any, any>) => eb('posts.views', '>', n),
    defineScope: (table, name, scope) => defineScope<any>()(table, name, scope),
    external: (utils, fn) =>
      db
        .transaction()
        .execute((trx) => fn((utils as KyselyTableUtils<any>).withTransaction(trx) as Utils)),
    time: (v) => (v instanceof Date ? v.getTime() : Date.parse(String(v))),
    queries: () => queries,
  }
}

runTableSuite(
  'kysely-table-utils (sqlite)',
  harness('sqlite', new SqliteDialect({ database: new Database(':memory:') })),
)

runTableSuite('kysely-table-utils (postgres)', harness('postgres', new PGliteDialect(new PGlite())))

it('throws for dialects other than Postgres and SQLite', () => {
  const db = new Kysely<any>({ dialect: new MysqlDialect({ pool: {} as any }) })
  expect(() => new KyselyTableUtils(db)).toThrow(
    'kysely-table-utils supports Postgres and SQLite, not MysqlAdapter',
  )
})
