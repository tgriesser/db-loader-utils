# @tgriesser/db-loader-utils

DataLoader boilerplate for [kysely](https://kysely.dev), [knex](https://knexjs.org),
and Redis via [ioredis](https://github.com/redis/ioredis) or
[node-redis](https://github.com/redis/node-redis). Every loader lives in a single
`Map` on the instance, so a request-scoped instance can clear or dispose all of
them at once.

```sh
pnpm add @tgriesser/db-loader-utils dataloader
```

## Usage

```ts
// kysely — `DB` is the same table map you give `Kysely<DB>`; rows come back `Selectable`.
import { KyselyLoaderUtils } from '@tgriesser/db-loader-utils/kysely'
const loaders = new KyselyLoaderUtils(db)

// knex — `DB` maps table name to row type.
import { KnexLoaderUtils } from '@tgriesser/db-loader-utils/knex'
const loaders = new KnexLoaderUtils<{ users: User; posts: Post }>(knex)
```

Each method returns a `DataLoader` that is created once per key and reused:

```ts
await loaders.byColumn('users', 'id').load(1) // User | null
await loaders.byColumnOrThrow('users', 'id').load(1) // User, rejects with NotFoundError
await loaders.byColumnPick('users', 'id', ['name']).load(1) // { id, name } | null
await loaders.byColumnSingle('users', 'id', 'name').load(1) // string | null
await loaders.manyByColumn('posts', 'user_id').load(1) // Post[]
await loaders.manyByColumnPick('posts', 'user_id', ['title'], { distinct: true }).load(1)
await loaders.countByColumn('posts', 'user_id').load(1) // number
await loaders.sumByColumn('posts', 'user_id', ['views']).load(1) // { views: number }

// posts for an org, through users: keyed by users.org_id, each row includes org_id
await loaders.manyByColumnJoin(['posts', 'user_id', 'users', 'id'], 'org_id').load(10)
```

### Scopes

A scope refines the query. Scopes are defined once, at module level, with the
adapter's `defineScope`, and the builder they receive is typed for the table(s)
named. Because a scope changes what a loader returns, each scoped loader is
registered under the scope's name, and the registry throws if the same name is
reached with a different definition or used on a loader for a different table.

```ts
import { defineScope, KyselyLoaderUtils } from '@tgriesser/db-loader-utils/kysely'

const scope = defineScope<DB>()
export const published = scope('posts', 'published', (qb) =>
  qb.where('posts.published_at', 'is not', null),
)
export const minViews = scope('posts', 'minViews', (qb, n: number) =>
  qb.where('posts.views', '>=', n),
)

loaders.manyByColumn('posts', 'user_id', { scope: published })
loaders.manyByColumn('posts', 'user_id', { scope: minViews.with(100) })
```

Parameters go through `.with(...)` rather than a closure, so they become part of
the loader key and each distinct argument list gets its own loader. A scope
defined on several tables, e.g. `scope(['posts', 'users'], ...)`, can be used
with `manyByColumnJoin`.

### Lifecycle

```ts
loaders.loader('custom', async (keys) => ...)  // get-or-create a custom loader in the same map
loaders.loaders                                // the Map<string, DataLoader>
loaders.clearAll()                             // clear every loader's cache
loaders.dispose()                              // clear caches and empty the map
```

Constructor options apply to every loader in the map:

- `maxBatchSize` (default 5000) caps the number of keys per `IN (...)`.
- `cache: false` keeps batching but drops per-key memoization, for instances
  that outlive a single request.

## Redis

The Redis entrypoints share the same registry (`loader`, `loaders`, `clearAll`,
`dispose`, `maxBatchSize`, `cache`) but are keyed by key patterns rather than
tables. Each pattern has one `{placeholder}` that the loaded id fills in.

```ts
import { IoredisLoaderUtils } from '@tgriesser/db-loader-utils/ioredis'
// or: import { NodeRedisLoaderUtils } from '@tgriesser/db-loader-utils/redis'

interface Cache {
  'user:{id}': User // JSON string
  'profile:{id}': { email: string } // hash
  'followers:{id}': string[] // set
}
const cache = new IoredisLoaderUtils<Cache>(redis)

await cache.get('user:{id}').load(1) // User | null, one MGET per batch
await cache.hash('profile:{id}').load(1) // { email } | null, pipelined HGETALL
await cache.hashField('profile:{id}', 'email').load(1) // string | null, pipelined HGET
await cache.members('followers:{id}').load(1) // string[], pipelined SMEMBERS
cache.key('user:{id}', 1) // 'user:1'
```

`get` decodes with `JSON.parse` by default; pass `decode(raw, key)` in the
options for anything else. A value that fails to decode rejects only its own key.

## Table utils

`/knex-table-utils` and `/kysely-table-utils` wrap common reads and writes on a
single table: finds, counts, inserts, updates, deletes, upserts and bulk updates. Postgres
is the primary target; SQLite works for everything except `afterUpdate` hooks. Other
dialects (MySQL, MSSQL, …) aren't supported, and the constructor throws for them.

```ts
import { KyselyTableUtils } from '@tgriesser/db-loader-utils/kysely-table-utils'
const tables = new KyselyTableUtils(db, {
  tables: { users: { createdAt: 'created_at', updatedAt: 'updated_at' } },
})

// knex — `DB` maps table name to row type or `Knex.CompositeTableType<Select, Insert, Update>`.
import { KnexTableUtils } from '@tgriesser/db-loader-utils/knex-table-utils'
const tables = new KnexTableUtils<DB>(knex)
```

```ts
const users = tables.table('users')

await users.findOneBy({ email }) // User | null; `null` values match IS NULL
await users.findOrFailBy({ id }) // User, rejects with RowNotFoundError
await users.findAllBy({ org_id: 10 }, { scope: (qb) => qb.orderBy('users.name') })
await users.exists({ email })
await users.countBy({ org_id: 10 })

await users.insert(row) // void
await users.insert(row, { returning: '*' }) // User
await users.insertMany(rows, { returning: ['id'] }) // { id }[]

await users.updateBy({ org_id: 10 }, { name: 'x' }) // number of rows updated
await users.updateOneBy({ id }, { name: 'x' }) // User | null
await users.destroyBy({ id }, { returning: '*' }) // User[]

await users.upsert(row, { conflictOn: ['email'], returning: '*' }) // merges every other column
await users.upsertMany(rows, { conflictOn: ['email'], exclude: ['name'] })
await users.upsertMany(rows, { onConflict: 'nothing' })

// Many rows, each with its own values, in one UPDATE ... FROM statement.
await users.updateManyBy('id', [
  { id: 1, name: 'a' },
  { id: 2, name: 'b' },
])

await users.findOrUpsert(row, ['email']) // select, then upsert only if missing
await users.findOrUpsertMany(rows, ['email']) // two statements at most; results line up with `rows`
```

- **Returning.** Writes return nothing (or a row count for updates and deletes) unless you
  pass `returning: '*'` or a list of columns.
- **Scopes.** Reads take a function of the select builder, or a scope made with the loader
  `defineScope`. Writes (`updateBy`, `destroyBy`, and an upsert's `where`) take a knex
  query-builder function, or a kysely where-expression such as `(eb) => eb('views', '>', 10)`.
  An update or delete with an empty `where` and no scope is refused.
- **Chunking.** Multi-row writes are split to stay under the dialect's bind-parameter limit
  (`maxBindings`). When a write needs more than one statement, the statements run in a
  single transaction.
- **updateManyBy.** Values are typed from the table's own columns, so no casts are
  needed. Every row must have the same columns.

### Timestamps and defaults

Per-table options set values on write. `createdAt` is never overwritten by an upsert, and an
explicit `updatedAt` value takes precedence. `now` supplies the timestamp (default
`() => new Date()`; SQLite drivers may need a string instead).

```ts
new KnexTableUtils<DB>(knex, {
  now: () => new Date(),
  tables: {
    runs: {
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      insertDefaults: () => ({ version: 1 }),
      updateDefaults: () => ({ version: knex.raw('runs.version + 1') }), // applied over `set`
    },
  },
})
```

### Transactions and hooks

```ts
await tables.transaction(async (t) => {
  await t.table('users').insert(row)
  await t.knex('audit').insert(entry) // `t.knex` / `t.db` is the transaction
})
const bound = tables.withTransaction(trx) // bind a transaction you opened yourself
```

`afterInsert`, `afterUpdate` and `afterDelete` table options receive the affected rows
once the write commits: right away outside a transaction, after commit inside one, and
never on rollback. Hooks don't block or fail the write; errors go to `onHookError`.

```ts
tables: {
  runs: {
    afterInsert: ({ rows }) => replicate(rows),
    // Postgres only: `before` is read in the same statement as the update.
    afterUpdate: ({ before, after }) => replicate([...before, ...after]),
  },
}
```

- **What forces full rows.** A table with hooks always writes with `RETURNING *`.
  `upsert` and `updateManyBy` aren't supported on it, since neither can report the hook's rows.
- **`withTransaction` and hooks.** With knex, `withTransaction` waits for the transaction
  you opened to commit. kysely has no way to observe that, so a hooked write through a
  kysely `withTransaction` throws; use `transaction()` instead.

### Other query builders

`DBLoaderUtils` from the root entrypoint takes any object implementing the
`Adapter` interface (`select`, `selectJoin`, `aggregate`); see `src/knex.ts`
for a small reference implementation.
