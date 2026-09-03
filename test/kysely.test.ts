import Database from 'better-sqlite3'
import { Kysely, SqliteDialect, sql } from 'kysely'
import { defineScope, KyselyLoaderUtils } from '../src/kysely'
import { runSuite, SCHEMA, type DB, type Harness } from './suite'

runSuite('kysely', (options) => {
  let queries = 0
  const db = new Kysely<DB>({
    dialect: new SqliteDialect({ database: new Database(':memory:') }),
    log: (event) => {
      if (event.level === 'query') queries++
    },
  })
  const utils = new KyselyLoaderUtils<DB>(db, options)
  return {
    utils,
    queryCount: () => queries,
    defineScope: defineScope<any>() as Harness['defineScope'],
    async setup() {
      for (const stmt of SCHEMA) await sql.raw(stmt).execute(db)
      queries = 0
    },
  }
})
