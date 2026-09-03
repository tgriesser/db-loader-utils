// Compile-time assertions, checked by `pnpm typecheck`.
import type DataLoader from 'dataloader'
import type { Generated, Kysely } from 'kysely'
import type { Knex } from 'knex'
import { defineScope as defineKnexScope, KnexLoaderUtils } from '../src/knex'
import { defineScope as defineKyselyScope, KyselyLoaderUtils } from '../src/kysely'

interface KyselyDB {
  users: { id: Generated<number>; name: string; org_id: number }
  posts: { id: Generated<number>; user_id: number; title: string; views: number }
}
type UserRow = { id: number; name: string; org_id: number }
type PostRow = { id: number; user_id: number; title: string; views: number }

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
declare function assert<T extends true>(): void

declare const db: Kysely<KyselyDB>
const ky = new KyselyLoaderUtils(db)

assert<Equal<ReturnType<typeof ky.byColumn<'users', 'id'>>, DataLoader<number, UserRow | null>>>()
assert<Equal<ReturnType<typeof ky.byColumnOrThrow<'users', 'name'>>, DataLoader<string, UserRow>>>()
assert<
  Equal<
    ReturnType<typeof ky.byColumnPick<'users', 'id', 'name'>>,
    DataLoader<number, Pick<UserRow, 'id' | 'name'> | null>
  >
>()
assert<
  Equal<
    ReturnType<typeof ky.byColumnSingle<'users', 'id', 'name'>>,
    DataLoader<number, string | null>
  >
>()
assert<
  Equal<ReturnType<typeof ky.manyByColumn<'posts', 'user_id'>>, DataLoader<number, PostRow[]>>
>()
assert<Equal<ReturnType<typeof ky.countByColumn<'posts', 'user_id'>>, DataLoader<number, number>>>()
assert<
  Equal<
    ReturnType<typeof ky.sumByColumn<'posts', 'user_id', 'views'>>,
    DataLoader<number, { views: number }>
  >
>()
assert<
  Equal<
    ReturnType<typeof ky.manyByColumnJoin<'posts', 'user_id', 'users', 'id', 'org_id'>>,
    DataLoader<number, Array<PostRow & { org_id: number }>>
  >
>()

// kysely scopes are typed for the table(s) they are defined on
const scope = defineKyselyScope<KyselyDB>()
const popular = scope('posts', 'popular', (qb) => qb.where('posts.views', '>', 4))
const minViews = scope('posts', 'minViews', (qb, n: number) => qb.where('posts.views', '>=', n))
const orgPosts = scope(['posts', 'users'], 'orgPosts', (qb) =>
  qb.where('users.name', 'like', 'a%').where('posts.views', '>', 0),
)
ky.manyByColumn('posts', 'user_id', { scope: popular })
ky.manyByColumn('posts', 'user_id', { scope: minViews.with(3) })
ky.manyByColumnJoin(['posts', 'user_id', 'users', 'id'], 'org_id', { scope: orgPosts })
ky.manyByColumnJoin(['posts', 'user_id', 'users', 'id'], 'org_id', { scope: popular })
// @ts-expect-error users columns are not in scope for a posts scope
scope('posts', 'bad', (qb) => qb.where('users.name', '=', 'x'))
// @ts-expect-error unknown table in scope definition
scope('nope', 'bad', (qb) => qb)
// @ts-expect-error a posts scope cannot be used on a users loader
ky.byColumn('users', 'id', { scope: popular })
// @ts-expect-error a parameterized scope must be bound with `.with(...)`
ky.manyByColumn('posts', 'user_id', { scope: minViews })
// @ts-expect-error wrong argument type
minViews.with('3')
// @ts-expect-error inline functions are not scopes
ky.byColumn('users', 'id', { scope: (qb) => qb })
// @ts-expect-error unknown table
ky.byColumn('nope', 'id')
// @ts-expect-error unknown column
ky.byColumn('users', 'nope')

declare const knex: Knex
type KnexDB = { users: UserRow; posts: PostRow }
const kn = new KnexLoaderUtils<KnexDB>(knex)
const knexScope = defineKnexScope<KnexDB>()
const named = knexScope('users', 'named', (qb) => qb.whereNotNull('users.name'))
assert<Equal<ReturnType<typeof kn.byColumn<'users', 'id'>>, DataLoader<number, UserRow | null>>>()
kn.byColumn('users', 'id', { scope: named })
// @ts-expect-error unknown table in scope definition
knexScope('nope', 'bad', (qb) => qb)
