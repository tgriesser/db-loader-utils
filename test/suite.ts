import { describe, expect, it, beforeEach } from 'vitest'
import type { DBLoaderUtils, LoaderUtilsOptions, ScopeDef } from '../src/index'
import { NotFoundError } from '../src/index'

export interface Users {
  id: number
  name: string
  org_id: number
}
export interface Posts {
  id: number
  user_id: number
  title: string
  views: number
}
export interface DB {
  users: Users
  posts: Posts
}

export const SCHEMA = [
  'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, org_id INTEGER NOT NULL)',
  'CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, title TEXT NOT NULL, views INTEGER NOT NULL)',
  "INSERT INTO users VALUES (1, 'ada', 10), (2, 'bob', 10), (3, 'cy', 20)",
  "INSERT INTO posts VALUES (1, 1, 'a1', 5), (2, 1, 'a2', 7), (3, 2, 'b1', 1), (4, 3, 'c1', 100)",
]

export interface Harness {
  utils: DBLoaderUtils<DB, any>
  queryCount(): number
  /** The adapter's `defineScope`, typed loosely so the suite can share scope bodies. */
  defineScope: <Args extends unknown[] = []>(
    tables: string | readonly string[],
    name: string,
    scope: (qb: any, ...args: Args) => any,
  ) => ScopeDef<any, Args>
  setup(): Promise<void>
}

export function runSuite(name: string, make: (options?: LoaderUtilsOptions) => Harness) {
  describe(name, () => {
    let h: Harness
    beforeEach(async () => {
      h = make()
      await h.setup()
    })

    it('byColumn batches into one query and returns null for misses', async () => {
      const loader = h.utils.byColumn('users', 'id')
      const [a, b, missing] = await Promise.all([loader.load(1), loader.load(2), loader.load(99)])
      expect(a).toMatchObject({ id: 1, name: 'ada' })
      expect(b).toMatchObject({ id: 2, name: 'bob' })
      expect(missing).toBeNull()
      expect(h.queryCount()).toBe(1)
    })

    it('byColumnOrThrow rejects missing keys with NotFoundError', async () => {
      const loader = h.utils.byColumnOrThrow('users', 'id')
      await expect(loader.load(1)).resolves.toMatchObject({ name: 'ada' })
      await expect(loader.load(99)).rejects.toBeInstanceOf(NotFoundError)
      await expect(loader.load(99)).rejects.toMatchObject({ table: 'users', column: 'id', key: 99 })
    })

    it('byColumnPick and byColumnSingle', async () => {
      const pick = await h.utils.byColumnPick('users', 'id', ['name']).load(3)
      expect(pick).toEqual({ id: 3, name: 'cy' })
      const single = await h.utils.byColumnSingle('users', 'id', 'name').load(3)
      expect(single).toBe('cy')
      expect(await h.utils.byColumnSingle('users', 'id', 'name').load(99)).toBeNull()
    })

    it('manyByColumn groups rows and returns [] for misses', async () => {
      const loader = h.utils.manyByColumn('posts', 'user_id')
      const [ada, bob, none] = await Promise.all([loader.load(1), loader.load(2), loader.load(99)])
      expect(ada.map((p) => p.title)).toEqual(['a1', 'a2'])
      expect(bob.map((p) => p.title)).toEqual(['b1'])
      expect(none).toEqual([])
      expect(h.queryCount()).toBe(1)
    })

    it('manyByColumnPick supports distinct', async () => {
      const loader = h.utils.manyByColumnPick('users', 'org_id', ['org_id'], { distinct: true })
      expect(await loader.load(10)).toEqual([{ org_id: 10 }])
    })

    it('scoped loaders are keyed separately by scope', async () => {
      const popularScope = h.defineScope('posts', 'popular', (qb) =>
        qb.where('posts.views', '>', 4),
      )
      const all = h.utils.manyByColumn('posts', 'user_id')
      const popular = h.utils.manyByColumn('posts', 'user_id', { scope: popularScope })
      expect(popular).not.toBe(all)
      expect(popular).toBe(h.utils.manyByColumn('posts', 'user_id', { scope: popularScope }))
      expect((await all.load(1)).map((p) => p.title)).toEqual(['a1', 'a2'])
      expect((await popular.load(1)).map((p) => p.title)).toEqual(['a1', 'a2'])
      expect((await popular.load(2)).map((p) => p.title)).toEqual([])
    })

    it('parameterized scopes key by their arguments', async () => {
      const minViews = h.defineScope('posts', 'minViews', (qb, n: number) =>
        qb.where('posts.views', '>=', n),
      )
      const atLeast6 = h.utils.manyByColumn('posts', 'user_id', { scope: minViews.with(6) })
      const atLeast1 = h.utils.manyByColumn('posts', 'user_id', { scope: minViews.with(1) })
      expect(atLeast6).not.toBe(atLeast1)
      expect(atLeast6).toBe(h.utils.manyByColumn('posts', 'user_id', { scope: minViews.with(6) }))
      expect((await atLeast6.load(1)).map((p) => p.title)).toEqual(['a2'])
      expect((await atLeast1.load(1)).map((p) => p.title)).toEqual(['a1', 'a2'])
    })

    it('rejects a different scope definition under an already registered name', () => {
      const a = h.defineScope('posts', 'popular', (qb) => qb.where('posts.views', '>', 4))
      const b = h.defineScope('posts', 'popular', (qb) => qb.where('posts.views', '>', 400))
      h.utils.manyByColumn('posts', 'user_id', { scope: a })
      expect(() => h.utils.manyByColumn('posts', 'user_id', { scope: b })).toThrow(
        /already registered/,
      )
      h.utils.dispose()
      expect(() => h.utils.manyByColumn('posts', 'user_id', { scope: b })).not.toThrow()
    })

    it('rejects a scope defined for a table the loader does not query', () => {
      const usersOnly = h.defineScope('users', 'named', (qb) => qb.whereNotNull('users.name'))
      expect(() => h.utils.byColumn('posts', 'id', { scope: usersOnly })).toThrow(
        /defined for "users"/,
      )
      expect(() =>
        h.utils.manyByColumnJoin(['posts', 'user_id', 'users', 'id'], 'org_id', {
          scope: usersOnly,
        }),
      ).not.toThrow()
    })

    it('manyByColumnJoin loads through a join keyed by the join constraint', async () => {
      const loader = h.utils.manyByColumnJoin(['posts', 'user_id', 'users', 'id'], 'org_id')
      const [org10, org20, none] = await Promise.all([
        loader.load(10),
        loader.load(20),
        loader.load(99),
      ])
      expect(org10.map((p) => p.title).sort()).toEqual(['a1', 'a2', 'b1'])
      expect(org10[0]).toMatchObject({ org_id: 10 })
      expect(org20.map((p) => p.title)).toEqual(['c1'])
      expect(none).toEqual([])
      expect(h.queryCount()).toBe(1)
    })

    it('countByColumn and sumByColumn', async () => {
      const count = h.utils.countByColumn('posts', 'user_id')
      expect(await Promise.all([count.load(1), count.load(3), count.load(99)])).toEqual([2, 1, 0])
      const sum = h.utils.sumByColumn('posts', 'user_id', ['views'])
      expect(await Promise.all([sum.load(1), sum.load(99)])).toEqual([{ views: 12 }, { views: 0 }])
      expect(h.queryCount()).toBe(2)
    })

    it('returns the same loader instance for the same key', () => {
      expect(h.utils.byColumn('users', 'id')).toBe(h.utils.byColumn('users', 'id'))
      expect(h.utils.byColumn('users', 'id')).not.toBe(h.utils.byColumn('users', 'org_id'))
      expect(h.utils.byColumn('users', 'id')).not.toBe(h.utils.byColumnOrThrow('users', 'id'))
    })

    it('clearAll drops cached values; dispose empties the map', async () => {
      const loader = h.utils.byColumn('users', 'id')
      await loader.load(1)
      await loader.load(1)
      expect(h.queryCount()).toBe(1)
      h.utils.clearAll()
      await loader.load(1)
      expect(h.queryCount()).toBe(2)
      expect(h.utils.loaders.size).toBe(1)
      h.utils.dispose()
      expect(h.utils.loaders.size).toBe(0)
      expect(h.utils.byColumn('users', 'id')).not.toBe(loader)
    })

    it('names loaders after their key, marking uncached ones', () => {
      expect(h.utils.byColumn('users', 'id').name).toBe('byColumn:users.id')
      const scoped = h.defineScope('posts', 'popular', (qb) => qb.where('posts.views', '>', 4))
      expect(h.utils.manyByColumn('posts', 'user_id', { scope: scoped }).name).toBe(
        'manyByColumn:posts.user_id#popular',
      )
      expect(h.utils.loader('raw', async (keys) => keys, { cache: false }).name).toBe('raw:nocache')
      expect(h.utils.loader('named', async (keys) => keys, { name: 'custom' }).name).toBe('custom')
      const uncached = make({ cache: false })
      expect(uncached.utils.byColumn('users', 'id').name).toBe('byColumn:users.id:nocache')
    })

    it('custom loaders share the map', async () => {
      const custom = h.utils.loader<number, number>('double', async (keys) =>
        keys.map((k) => k * 2),
      )
      expect(await custom.load(2)).toBe(4)
      expect(h.utils.loaders.get('double')).toBe(custom)
    })

    it('cache: false skips memoization but still batches', async () => {
      h = make({ cache: false })
      await h.setup()
      const loader = h.utils.byColumn('users', 'id')
      await Promise.all([loader.load(1), loader.load(1), loader.load(2)])
      expect(h.queryCount()).toBe(1)
      await loader.load(1)
      expect(h.queryCount()).toBe(2)
    })

    it('respects maxBatchSize', async () => {
      h = make({ maxBatchSize: 2 })
      await h.setup()
      const loader = h.utils.byColumn('posts', 'id')
      await Promise.all([1, 2, 3, 4].map((id) => loader.load(id)))
      expect(h.queryCount()).toBe(2)
    })
  })
}
