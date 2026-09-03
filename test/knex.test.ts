import knexFactory from 'knex'
import { defineScope, KnexLoaderUtils } from '../src/knex'
import { runSuite, SCHEMA, type DB, type Harness } from './suite'

runSuite('knex', (options) => {
  const knex = knexFactory({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 },
  })
  let queries = 0
  knex.on('query', () => queries++)
  const utils = new KnexLoaderUtils<DB>(knex, options)
  return {
    utils,
    queryCount: () => queries,
    defineScope: defineScope<any>() as Harness['defineScope'],
    async setup() {
      for (const sql of SCHEMA) await knex.raw(sql)
      queries = 0
    },
  }
})
