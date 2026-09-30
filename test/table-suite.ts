import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScopeDef } from '../src/index'
import {
  RowNotFoundError,
  type Dialect,
  type TableUtils,
  type TableUtilsOptions,
} from '../src/core/table/exports'

// TS names are camelCase; every harness maps them to snake_case columns.
export interface User {
  id: number
  email: string
  name: string
  orgId: number | null
  createdAt: unknown
  updatedAt: unknown
}
export interface Post {
  id: number
  userId: number
  title: string
  views: number
  version: number
}
export interface Membership {
  id: number
  userId: number
  orgId: number
  role: string
}
type Tables = {
  users: { select: User; insert: Partial<User>; update: Partial<User> }
  posts: { select: Post; insert: Partial<Post>; update: Partial<Post> }
  memberships: { select: Membership; insert: Partial<Membership>; update: Partial<Membership> }
}
export type Utils = TableUtils<Tables, any>

export function schema(dialect: Dialect): string[] {
  const id = dialect === 'postgres' ? 'serial primary key' : 'integer primary key'
  const ts = dialect === 'postgres' ? 'timestamptz' : 'text'
  return [
    'drop table if exists users',
    'drop table if exists posts',
    'drop table if exists memberships',
    `create table users (id ${id}, email text not null unique, name text not null, org_id integer, created_at ${ts}, updated_at ${ts})`,
    `create table posts (id ${id}, user_id integer not null, title text not null, views integer not null default 0, version integer not null default 0)`,
    `create table memberships (id ${id}, user_id integer not null, org_id integer not null, role text not null, unique (user_id, org_id))`,
  ]
}

export interface TableHarness {
  dialect: Dialect
  setup(): Promise<void>
  teardown(): Promise<void>
  make(options?: TableUtilsOptions<Tables, any>): Utils
  /** A builder expression for `updateDefaults` / `set`. */
  raw(sql: string): unknown
  /** A write scope: `posts.views > n`. */
  viewsAbove(n: number): unknown
  /** The loader `defineScope`, to check read scopes accept it. */
  defineScope(table: string, name: string, scope: (qb: any) => any): ScopeDef<any>
  /** Whether `withTransaction` can observe the caller's commit (knex can, kysely can't). */
  externalCommit: boolean
  /** Runs `fn` in a transaction the caller opened, bound with `withTransaction`. */
  external(utils: Utils, fn: (bound: Utils) => Promise<void>): Promise<void>
  /** A `createdAt` value as epoch ms. */
  time(value: unknown): number
  queries(): number
}

let clock = 0
const tick = () => new Date(Date.UTC(2024, 0, 1, 0, 0, ++clock))

export function runTableSuite(name: string, h: TableHarness) {
  describe(name, () => {
    const pg = h.dialect === 'postgres'
    const now = () => (pg ? tick() : tick().toISOString())
    const timestamps = {
      users: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
    } as const
    let t: Utils

    afterAll(() => h.teardown())
    beforeEach(async () => {
      await h.setup()
      t = h.make({ now, tables: timestamps })
      await t.table('users').insertMany([
        { email: 'ada@x', name: 'ada', orgId: 10 },
        { email: 'bob@x', name: 'bob', orgId: 10 },
        { email: 'cy@x', name: 'cy', orgId: null },
      ])
      await t.table('posts').insertMany([
        { userId: 1, title: 'a1', views: 5 },
        { userId: 1, title: 'a2', views: 7 },
        { userId: 2, title: 'b1', views: 1 },
      ])
    })

    describe('reads', () => {
      it('findOneBy / findAllBy / findOrFailBy', async () => {
        const users = t.table('users')
        expect(await users.findOneBy({ name: 'ada' })).toMatchObject({ id: 1, orgId: 10 })
        expect(await users.findOneBy({ name: 'nobody' })).toBeNull()
        expect((await users.findAllBy({ orgId: 10 })).map((u) => u.name).sort()).toEqual([
          'ada',
          'bob',
        ])
        expect((await users.findAllBy({})).length).toBe(3)
        await expect(users.findOrFailBy({ id: 99 })).rejects.toBeInstanceOf(RowNotFoundError)
        await expect(users.findOrFailBy({ id: 99 })).rejects.toMatchObject({
          table: 'users',
          where: { id: 99 },
        })
      })

      it('null matches IS NULL and undefined is refused', async () => {
        const users = t.table('users')
        expect((await users.findAllBy({ orgId: null })).map((u) => u.name)).toEqual(['cy'])
        await expect(users.findAllBy({ orgId: undefined })).rejects.toThrow(/orgId is undefined/)
      })

      it('exists and countBy', async () => {
        const posts = t.table('posts')
        expect(await posts.exists({ userId: 1 })).toBe(true)
        expect(await posts.exists({ userId: 99 })).toBe(false)
        expect(await posts.countBy({ userId: 1 })).toBe(2)
        expect(await posts.countBy({})).toBe(3)
        const ordered = (qb: any) => qb.where('posts.views', '>', 4).orderBy('posts.id')
        expect(await posts.countBy({}, { scope: ordered })).toBe(2)
      })

      it('accepts plain scopes and loader defineScope scopes', async () => {
        const posts = t.table('posts')
        const popular = (qb: any) => qb.where('posts.views', '>', 4).orderBy('posts.id', 'desc')
        expect((await posts.findAllBy({}, { scope: popular })).map((p) => p.title)).toEqual([
          'a2',
          'a1',
        ])
        const defined = h.defineScope('posts', 'popular', (qb) => qb.where('posts.views', '>', 6))
        expect((await posts.findAllBy({}, { scope: defined })).map((p) => p.title)).toEqual(['a2'])
        const usersOnly = h.defineScope('users', 'named', (qb) => qb)
        await expect(posts.findAllBy({}, { scope: usersOnly })).rejects.toThrow(
          /not defined for "posts"/,
        )
      })
    })

    describe('inserts', () => {
      it('insert returns nothing, every column, or the picked columns', async () => {
        const users = t.table('users')
        expect(await users.insert({ email: 'd@x', name: 'd' })).toBeUndefined()
        const all = await users.insert({ email: 'e@x', name: 'e' }, { returning: '*' })
        expect(all).toMatchObject({ id: 5, email: 'e@x', orgId: null })
        expect(h.time(all.createdAt)).toBeGreaterThan(0)
        expect(all.updatedAt).toEqual(all.createdAt)
        expect(await users.insert({ email: 'f@x', name: 'f' }, { returning: ['id'] })).toEqual({
          id: 6,
        })
      })

      it('an explicit createdAt wins over the default', async () => {
        const createdAt = pg
          ? new Date(Date.UTC(2000, 0, 1))
          : new Date(Date.UTC(2000, 0, 1)).toISOString()
        const row = await t
          .table('users')
          .insert({ email: 'd@x', name: 'd', createdAt }, { returning: '*' })
        expect(h.time(row.createdAt)).toBe(Date.UTC(2000, 0, 1))
      })

      it('insertMany returns rows in order and handles empty input', async () => {
        const posts = t.table('posts')
        expect(await posts.insertMany([], { returning: '*' })).toEqual([])
        const rows = await posts.insertMany(
          [
            { userId: 3, title: 'c1' },
            { userId: 3, title: 'c2' },
          ],
          { returning: ['id', 'title'] },
        )
        expect(rows).toEqual([
          { id: 4, title: 'c1' },
          { id: 5, title: 'c2' },
        ])
      })

      it('splits by maxBindings and rolls every chunk back together', async () => {
        const small = h.make({ maxBindings: 4 })
        const rows = await small.table('posts').insertMany(
          [1, 2, 3, 4, 5].map((i) => ({ userId: 9, title: `t${i}` })),
          { returning: ['title'] },
        )
        expect(rows.map((r) => r.title)).toEqual(['t1', 't2', 't3', 't4', 't5'])
        await expect(
          small.table('users').insertMany([
            { email: 'new1@x', name: 'n' },
            { email: 'new2@x', name: 'n' },
            { email: 'new3@x', name: 'n' },
            { email: 'ada@x', name: 'dupe' },
          ]),
        ).rejects.toThrow()
        expect(await t.table('users').countBy({})).toBe(3)
      })
    })

    describe('updates and deletes', () => {
      it('updateBy returns a count or rows and bumps updatedAt', async () => {
        const users = t.table('users')
        const before = await users.findOrFailBy({ id: 1 })
        expect(await users.updateBy({ orgId: 10 }, { name: 'x' })).toBe(2)
        const [row] = await users.updateBy({ id: 1 }, { name: 'y' }, { returning: '*' })
        expect(row).toMatchObject({ id: 1, name: 'y' })
        expect(h.time(row!.updatedAt)).toBeGreaterThan(h.time(before.updatedAt))
        expect(row!.createdAt).toEqual(before.createdAt)
        expect(await users.updateBy({ id: 99 }, { name: 'z' })).toBe(0)
      })

      it('applies updateDefaults over set, and accepts expressions', async () => {
        const v = h.make({
          tables: { posts: { updateDefaults: () => ({ version: h.raw('version + 1') }) } },
        })
        const posts = v.table('posts')
        await posts.updateBy({ id: 1 }, { title: 'a1!' })
        const [row] = await posts.updateBy(
          { id: 1 },
          { views: h.raw('views * 2') as any },
          { returning: ['views', 'version'] },
        )
        expect(row).toEqual({ views: 10, version: 2 })
      })

      it('write scopes narrow the where, and an unscoped empty where is refused', async () => {
        const posts = t.table('posts')
        expect(
          await posts.updateBy({ userId: 1 }, { title: 'hot' }, { scope: h.viewsAbove(6) as any }),
        ).toBe(1)
        expect((await posts.findOrFailBy({ id: 2 })).title).toBe('hot')
        expect(await posts.updateBy({}, { title: 'hot' }, { scope: h.viewsAbove(4) as any })).toBe(
          2,
        )
        await expect(posts.updateBy({}, { title: 'all' })).rejects.toThrow(/non-empty where/)
        await expect(posts.destroyBy({})).rejects.toThrow(/non-empty where/)
      })

      it('updateOneBy and updateOneByOrFail', async () => {
        const users = t.table('users')
        expect(await users.updateOneBy({ id: 2 }, { name: 'b' })).toMatchObject({
          id: 2,
          name: 'b',
        })
        expect(await users.updateOneBy({ id: 2 }, { name: 'b2' }, { returning: ['name'] })).toEqual(
          {
            name: 'b2',
          },
        )
        expect(await users.updateOneBy({ id: 99 }, { name: 'b' })).toBeNull()
        await expect(users.updateOneByOrFail({ id: 99 }, { name: 'b' })).rejects.toBeInstanceOf(
          RowNotFoundError,
        )
      })

      it('destroyBy returns a count or rows', async () => {
        const posts = t.table('posts')
        expect(await posts.destroyBy({ id: 3 })).toBe(1)
        expect(await posts.destroyBy({ userId: 1 }, { returning: ['title'] })).toEqual(
          expect.arrayContaining([{ title: 'a1' }, { title: 'a2' }]),
        )
        expect(await posts.countBy({})).toBe(0)
      })
    })

    describe('upserts', () => {
      it('merges on conflict, keeping createdAt', async () => {
        const users = t.table('users')
        const before = await users.findOrFailBy({ email: 'ada@x' })
        const row = await users.upsert(
          { email: 'ada@x', name: 'ada2', orgId: 11 },
          { conflictOn: ['email'], returning: '*' },
        )
        expect(row).toMatchObject({ id: 1, name: 'ada2', orgId: 11 })
        expect(row.createdAt).toEqual(before.createdAt)
        expect(h.time(row.updatedAt)).toBeGreaterThan(h.time(before.updatedAt))
        const inserted = await users.upsert(
          { email: 'new@x', name: 'n' },
          { conflictOn: ['email'], returning: ['email'] },
        )
        expect(inserted).toEqual({ email: 'new@x' })
      })

      it('exclude, onConflict nothing, and where', async () => {
        const users = t.table('users')
        const kept = await users.upsert(
          { email: 'ada@x', name: 'ada2', orgId: 11 },
          { conflictOn: ['email'], exclude: ['name'], returning: '*' },
        )
        expect(kept).toMatchObject({ name: 'ada', orgId: 11 })
        expect(
          await users.upsert(
            { email: 'ada@x', name: 'nope' },
            { conflictOn: ['email'], onConflict: 'nothing', returning: '*' },
          ),
        ).toBeNull()
        const posts = t.table('posts')
        expect(
          await h
            .make()
            .table('posts')
            .upsert(
              { id: 3, userId: 2, title: 'b1!' },
              { conflictOn: ['id'], where: h.viewsAbove(4) as any, returning: '*' },
            ),
        ).toBeNull()
        expect((await posts.findOrFailBy({ id: 3 })).title).toBe('b1')
      })

      it('returns the existing row when every other column is excluded', async () => {
        const row = await t
          .table('posts')
          .upsert(
            { id: 1, userId: 2, title: 'nope' },
            { conflictOn: ['id'], exclude: ['userId', 'title'], returning: '*' },
          )
        expect(row).toMatchObject({ id: 1, userId: 1, title: 'a1' })
      })

      it('upsertMany merges each row and requires matching columns', async () => {
        const users = t.table('users')
        const rows = await users.upsertMany(
          [
            { email: 'ada@x', name: 'A' },
            { email: 'new@x', name: 'N' },
          ],
          { conflictOn: ['email'], returning: ['email', 'name'] },
        )
        expect(rows).toEqual(
          expect.arrayContaining([
            { email: 'ada@x', name: 'A' },
            { email: 'new@x', name: 'N' },
          ]),
        )
        await expect(
          users.upsertMany([{ email: 'a', name: 'a' }, { email: 'b' }], { conflictOn: ['email'] }),
        ).rejects.toThrow(/same columns/)
        await users.upsertMany([{ email: 'bob@x', name: 'B' }], {
          conflictOn: ['email'],
          onConflict: 'nothing',
        })
        expect((await users.findOrFailBy({ email: 'bob@x' })).name).toBe('bob')
      })
    })

    describe('updateManyBy', () => {
      it('updates each row with its own values in one statement', async () => {
        const users = t.table('users')
        const before = await users.findOrFailBy({ id: 1 })
        const q = h.queries()
        const count = await users.updateManyBy('id', [
          { id: 1, name: 'A', orgId: null },
          { id: 2, name: 'B', orgId: 20 },
          { id: 99, name: 'Z', orgId: 1 },
        ])
        expect(h.queries() - q).toBe(1)
        expect(count).toBe(2)
        const rows = await users.findAllBy({}, { scope: (qb: any) => qb.orderBy('users.id') })
        expect(rows.map((r) => [r.name, r.orgId])).toEqual([
          ['A', null],
          ['B', 20],
          ['cy', null],
        ])
        expect(h.time(rows[0]!.updatedAt)).toBeGreaterThan(h.time(before.updatedAt))
      })

      it('matches on composite keys and returns rows', async () => {
        const m = t.table('memberships')
        await m.insertMany([
          { userId: 1, orgId: 10, role: 'member' },
          { userId: 2, orgId: 10, role: 'member' },
          { userId: 1, orgId: 20, role: 'member' },
        ])
        const rows = await m.updateManyBy(
          ['userId', 'orgId'],
          [
            { userId: 1, orgId: 10, role: 'admin' },
            { userId: 1, orgId: 20, role: 'owner' },
          ],
          { returning: ['userId', 'orgId', 'role'] },
        )
        expect(rows).toEqual(
          expect.arrayContaining([
            { userId: 1, orgId: 10, role: 'admin' },
            { userId: 1, orgId: 20, role: 'owner' },
          ]),
        )
        expect(rows).toHaveLength(2)
        expect((await m.findOrFailBy({ userId: 2 })).role).toBe('member')
      })

      it('validates rows', async () => {
        const posts = t.table('posts')
        expect(await posts.updateManyBy('id', [])).toBe(0)
        await expect(
          posts.updateManyBy('id', [{ id: 1, title: 'x' }, { id: 2 } as any]),
        ).rejects.toThrow(/same columns/)
        await expect(posts.updateManyBy('id', [{ id: 1 }])).rejects.toThrow(/no columns to set/)
        await expect(posts.updateManyBy('id', [{ title: 'x' } as any])).rejects.toThrow(
          /missing key/,
        )
        await expect(posts.updateManyBy('id', [{ id: 1, title: undefined }])).rejects.toThrow(
          /undefined/,
        )
      })

      it('chunks by maxBindings', async () => {
        const small = h.make({ maxBindings: 4 })
        const count = await small.table('posts').updateManyBy(
          'id',
          [1, 2, 3].map((id) => ({ id, views: id * 100 })),
        )
        expect(count).toBe(3)
        expect((await t.table('posts').findOrFailBy({ id: 3 })).views).toBe(300)
      })
    })

    describe('find-or-write', () => {
      it('findOrUpsert / findOrUpsertWithMeta', async () => {
        const users = t.table('users')
        expect(
          await users.findOrUpsertWithMeta({ email: 'ada@x', name: 'ignored' }, ['email']),
        ).toMatchObject({
          created: false,
          row: { id: 1, name: 'ada' },
        })
        expect(
          await users.findOrUpsertWithMeta({ email: 'new@x', name: 'n' }, ['email']),
        ).toMatchObject({
          created: true,
          row: { id: 4, name: 'n' },
        })
        expect(await users.findOrUpsert({ email: 'new@x', name: 'n' }, ['email'])).toMatchObject({
          id: 4,
        })
      })

      it('findOrUpsertMany lines up with input, including duplicates and composite keys', async () => {
        const m = t.table('memberships')
        await m.insert({ userId: 1, orgId: 10, role: 'admin' })
        const q = h.queries()
        const rows = await m.findOrUpsertMany(
          [
            { userId: 2, orgId: 10, role: 'member' },
            { userId: 1, orgId: 10, role: 'ignored' },
            { userId: 2, orgId: 10, role: 'member' },
            { userId: 1, orgId: 1, role: 'member' },
          ],
          ['userId', 'orgId'],
        )
        expect(h.queries() - q).toBe(2)
        expect(rows.map((r) => [r.userId, r.orgId, r.role])).toEqual([
          [2, 10, 'member'],
          [1, 10, 'admin'],
          [2, 10, 'member'],
          [1, 1, 'member'],
        ])
        expect(rows[0]).toBe(rows[2])
        expect(await m.countBy({})).toBe(3)
        expect(await m.findOrUpsertMany([], ['userId'])).toEqual([])
      })

      it('findOrCreateBy', async () => {
        const posts = t.table('posts')
        expect(await posts.findOrCreateBy({ userId: 1, title: 'a1' })).toMatchObject({ id: 1 })
        expect(await posts.findOrCreateBy({ userId: 1, title: 'a3' })).toMatchObject({ id: 4 })
      })
    })

    describe('transactions', () => {
      it('commits, rolls back, and binds the executor', async () => {
        await t.transaction(async (tx) => {
          await tx.table('users').insert({ email: 'tx@x', name: 'tx' })
          expect(await tx.table('users').countBy({})).toBe(4)
          expect(await tx.transaction(async (inner) => inner === tx)).toBe(true)
        })
        expect(await t.table('users').countBy({})).toBe(4)
        await expect(
          t.transaction(async (tx) => {
            await tx.table('users').insert({ email: 'rb@x', name: 'rb' })
            throw new Error('boom')
          }),
        ).rejects.toThrow('boom')
        expect(await t.table('users').exists({ email: 'rb@x' })).toBe(false)
      })
    })

    describe('hooks', () => {
      function hooked(extra?: TableUtilsOptions<Tables, any>) {
        const events: Array<[string, any]> = []
        const utils = h.make({
          now,
          ...extra,
          tables: {
            users: {
              ...timestamps.users,
              afterInsert: (e) => void events.push(['insert', e]),
              afterDelete: (e) => void events.push(['delete', e]),
              ...(pg ? { afterUpdate: (e: any) => void events.push(['update', e]) } : {}),
            },
          },
        })
        return { utils, events }
      }

      it('afterInsert and afterDelete receive full rows', async () => {
        const { utils, events } = hooked()
        const users = utils.table('users')
        expect(await users.insert({ email: 'h@x', name: 'h' }, { returning: ['id'] })).toEqual({
          id: 4,
        })
        await users.destroyBy({ id: 4 })
        await vi.waitFor(() => expect(events).toHaveLength(2))
        expect(events[0]).toEqual([
          'insert',
          { table: 'users', rows: [expect.objectContaining({ id: 4, email: 'h@x' })] },
        ])
        expect(events[1]).toEqual([
          'delete',
          { table: 'users', rows: [expect.objectContaining({ id: 4 })] },
        ])
        await users.destroyBy({ id: 99 })
        await new Promise((r) => setTimeout(r, 5))
        expect(events).toHaveLength(2)
      })

      it('fire after commit and not on rollback', async () => {
        const { utils, events } = hooked()
        await utils.transaction(async (tx) => {
          await tx.table('users').insert({ email: 'h@x', name: 'h' })
          await new Promise((r) => setTimeout(r, 5))
          expect(events).toHaveLength(0)
        })
        await vi.waitFor(() => expect(events).toHaveLength(1))
        await utils
          .transaction(async (tx) => {
            await tx.table('users').insert({ email: 'h2@x', name: 'h' })
            throw new Error('rollback')
          })
          .catch(() => {})
        await new Promise((r) => setTimeout(r, 5))
        expect(events).toHaveLength(1)
      })

      it('chunked inserts queue their hooks until the chunks commit', async () => {
        const { utils, events } = hooked({ maxBindings: 6 })
        await utils
          .table('users')
          .insertMany([1, 2, 3].map((i) => ({ email: `c${i}@x`, name: 'c' })))
        await vi.waitFor(() => expect(events).toHaveLength(3))
        expect(events.flatMap(([, e]) => e.rows.map((r: User) => r.email))).toEqual([
          'c1@x',
          'c2@x',
          'c3@x',
        ])
      })

      it('hook errors go to onHookError without failing the write', async () => {
        const onHookError = vi.fn()
        const utils = h.make({
          onHookError,
          tables: {
            posts: {
              afterInsert: () => {
                throw new Error('hook failed')
              },
            },
          },
        })
        await expect(
          utils.table('posts').insert({ userId: 1, title: 'x' }),
        ).resolves.toBeUndefined()
        await vi.waitFor(() => expect(onHookError).toHaveBeenCalledOnce())
        expect(onHookError.mock.calls[0]).toEqual([expect.any(Error), 'afterInsert', 'posts'])
      })

      it("withTransaction defers hooks to the caller's commit, or refuses without one", async () => {
        const { utils, events } = hooked()
        const run = h.external(utils, async (bound) => {
          await bound.table('users').insert({ email: 'ext@x', name: 'e' })
          await new Promise((r) => setTimeout(r, 5))
          expect(events).toHaveLength(0)
        })
        if (h.externalCommit) {
          await run
          await vi.waitFor(() => expect(events).toHaveLength(1))
        } else {
          await expect(run).rejects.toThrow(/use transaction\(\)/)
          expect(await utils.table('users').exists({ email: 'ext@x' })).toBe(false)
        }
        await h.external(utils, async (bound) => {
          await bound.table('posts').insert({ userId: 1, title: 'no hooks' })
        })
        expect(await utils.table('posts').exists({ title: 'no hooks' })).toBe(true)
      })

      it('refuses writes whose hooks it cannot report', async () => {
        const { utils } = hooked()
        const users = utils.table('users')
        await expect(
          users.upsert({ email: 'ada@x', name: 'a' }, { conflictOn: ['email'] }),
        ).rejects.toThrow(/has hooks/)
        if (pg) {
          await expect(users.updateManyBy('id', [{ id: 1, name: 'a' }])).rejects.toThrow(
            /afterUpdate/,
          )
        }
      })

      if (pg) {
        it('afterUpdate receives the rows before and after the update', async () => {
          const { utils, events } = hooked()
          const rows = await utils
            .table('users')
            .updateBy({ orgId: 10 }, { name: 'z' }, { returning: ['id'] })
          expect(rows.map((r) => r.id).sort()).toEqual([1, 2])
          await vi.waitFor(() => expect(events).toHaveLength(1))
          const [, e] = events[0]!
          expect(e.before.map((r: User) => r.name).sort()).toEqual(['ada', 'bob'])
          expect(e.after.map((r: User) => r.name)).toEqual(['z', 'z'])
          expect(e.before[0]).not.toHaveProperty('tableutilsbefore')
          await utils.table('users').updateBy({ id: 99 }, { name: 'z' })
          await new Promise((r) => setTimeout(r, 5))
          expect(events).toHaveLength(1)
        })
      } else {
        it('afterUpdate needs Postgres', async () => {
          const utils = h.make({ tables: { users: { afterUpdate: () => {} } } })
          await expect(utils.table('users').updateBy({ id: 1 }, { name: 'z' })).rejects.toThrow(
            /need Postgres/,
          )
        })
      }
    })
  })
}
