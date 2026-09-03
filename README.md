# @tgriesser/db-loader-utils

DataLoader boilerplate for [kysely](https://kysely.dev) and [knex](https://knexjs.org).
Every loader lives in a single `Map` on the instance, so a request-scoped
instance can clear or dispose all of them at once.

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

### Other query builders

`DBLoaderUtils` from the root entrypoint takes any object implementing the
`Adapter` interface (`select`, `selectJoin`, `aggregate`); see `src/knex.ts`
for a small reference implementation.
