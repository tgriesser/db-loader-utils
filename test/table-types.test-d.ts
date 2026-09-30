// Compile-time assertions, checked by `pnpm typecheck`.
import type { Knex } from 'knex'
import type { Generated, Kysely } from 'kysely'
import { KnexTableUtils } from '../src/knex-table-utils'
import { defineScope } from '../src/kysely'
import { KyselyTableUtils } from '../src/kysely-table-utils'

interface KyselyDB {
  users: { id: Generated<number>; email: string; name: string; created_at: Generated<Date> }
  posts: { id: Generated<number>; user_id: number; title: string; views: number }
}
type UserRow = { id: number; email: string; name: string; created_at: Date }
type PostRow = { id: number; user_id: number; title: string; views: number }

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
declare function assert<T extends true>(): void
declare function typeOf<T>(value: Promise<T>): T

declare const db: Kysely<KyselyDB>
const ky = new KyselyTableUtils(db, {
  tables: {
    users: { createdAt: 'created_at' },
    // @ts-expect-error not a column of posts
    posts: { updatedAt: 'updated_at' },
  },
})
const users = ky.table('users')
const posts = ky.table('posts')

// @ts-expect-error unknown table
ky.table('nope')

// Reads
const one = typeOf(users.findOneBy({ id: 1 }))
assert<Equal<typeof one, UserRow | null>>()
const all = typeOf(posts.findAllBy({ user_id: 1 }))
assert<Equal<typeof all, PostRow[]>>()
assert<Equal<typeof ky.table<'users'>, (name: 'users') => typeof users>>()
// @ts-expect-error unknown column
users.findOneBy({ nope: 1 })
posts.findAllBy({}, { scope: (qb) => qb.where('posts.views', '>', 1).orderBy('posts.id') })
// @ts-expect-error unknown column in a read scope
posts.findAllBy({}, { scope: (qb) => qb.where('posts.nope', '>', 1) })
posts.findAllBy(
  {},
  { scope: defineScope<KyselyDB>()('posts', 'popular', (qb) => qb.where('views', '>', 1)) },
)

// Inserts: Generated columns are optional
const nothing = typeOf(users.insert({ email: 'a', name: 'a' }))
assert<Equal<typeof nothing, void>>()
const inserted = typeOf(users.insert({ email: 'a', name: 'a' }, { returning: '*' }))
assert<Equal<typeof inserted, UserRow>>()
const picked = typeOf(users.insertMany([{ email: 'a', name: 'a' }], { returning: ['id', 'name'] }))
assert<Equal<typeof picked, Pick<UserRow, 'id' | 'name'>[]>>()
// @ts-expect-error missing required column
users.insert({ email: 'a' })
// @ts-expect-error unknown returning column
users.insert({ email: 'a', name: 'a' }, { returning: ['nope'] })

// Updates and deletes
const count = typeOf(posts.updateBy({ id: 1 }, { views: 2 }))
assert<Equal<typeof count, number>>()
const updated = typeOf(posts.updateBy({ id: 1 }, { views: 2 }, { returning: ['views'] }))
assert<Equal<typeof updated, Pick<PostRow, 'views'>[]>>()
const oneUpdated = typeOf(posts.updateOneBy({ id: 1 }, { views: 2 }))
assert<Equal<typeof oneUpdated, PostRow | null>>()
posts.updateBy({}, { views: 2 }, { scope: (eb) => eb('views', '>', 1) })
// @ts-expect-error unknown column in a write scope
posts.updateBy({}, { views: 2 }, { scope: (eb) => eb('nope', '>', 1) })
// @ts-expect-error wrong value type
posts.updateBy({ id: 1 }, { views: 'many' })
const destroyed = typeOf(posts.destroyBy({ id: 1 }, { returning: '*' }))
assert<Equal<typeof destroyed, PostRow[]>>()
const many = typeOf(posts.updateManyBy('id', [{ id: 1, views: 2 }], { returning: ['id'] }))
assert<Equal<typeof many, Pick<PostRow, 'id'>[]>>()
// @ts-expect-error rows must include the key
posts.updateManyBy('id', [{ views: 2 }])

// Upserts
const merged = typeOf(
  users.upsert({ email: 'a', name: 'a' }, { conflictOn: ['email'], returning: '*' }),
)
assert<Equal<typeof merged, UserRow>>()
const skipped = typeOf(
  users.upsert({ email: 'a', name: 'a' }, { onConflict: 'nothing', returning: ['id'] }),
)
assert<Equal<typeof skipped, Pick<UserRow, 'id'> | null>>()
const found = typeOf(users.findOrUpsertMany([{ email: 'a', name: 'a' }], ['email']))
assert<Equal<typeof found, UserRow[]>>()

// knex: plain row types insert as Partial; CompositeTableType gives precise shapes
interface KnexDB {
  users: Knex.CompositeTableType<UserRow, Omit<UserRow, 'id' | 'created_at'>>
  posts: PostRow
}
declare const knex: Knex
const kn = new KnexTableUtils<KnexDB>(knex, { tables: { users: { createdAt: 'created_at' } } })
const knexUser = typeOf(kn.table('users').insert({ email: 'a', name: 'a' }, { returning: '*' }))
assert<Equal<typeof knexUser, UserRow>>()
// @ts-expect-error missing required column
kn.table('users').insert({ email: 'a' })
kn.table('posts').insert({ title: 'partial is fine' })
kn.table('posts').updateBy({ id: 1 }, { views: knex.raw('views + 1') })
kn.table('posts').updateBy({}, { views: 1 }, { scope: (qb) => qb.where('views', '>', 1) })
kn.transaction(async (t) => {
  assert<Equal<typeof t, typeof kn>>()
  t.knex satisfies Knex
})
