import Redis from 'ioredis'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RedisLoaderUtils, RedisLoaderUtilsOptions } from '../src/index'

export const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'
const PREFIX = 'loader-utils-test:'

export interface User {
  id: number
  name: string
}
export interface Schema {
  'loader-utils-test:user:{id}': User
  'loader-utils-test:profile:{id}': { email: string; age: string }
  'loader-utils-test:followers:{id}': string[]
}

export interface RedisHarness {
  utils: RedisLoaderUtils<Schema>
  /** Round trips for `get`: MGET calls on the underlying client. */
  mgetCalls(): number
  close(): Promise<void>
}

export async function seed() {
  const redis = new Redis(REDIS_URL)
  const stale = await redis.keys(`${PREFIX}*`)
  if (stale.length) await redis.del(...stale)
  await redis
    .multi()
    .set(`${PREFIX}user:1`, JSON.stringify({ id: 1, name: 'ada' }))
    .set(`${PREFIX}user:2`, JSON.stringify({ id: 2, name: 'bob' }))
    .set(`${PREFIX}user:3`, 'not json')
    .hset(`${PREFIX}profile:1`, { email: 'ada@example.com', age: '36' })
    .sadd(`${PREFIX}followers:1`, '2', '3')
    .exec()
  await redis.quit()
}

export function runRedisSuite(
  name: string,
  make: (options?: RedisLoaderUtilsOptions) => RedisHarness,
) {
  describe(name, () => {
    const open: RedisHarness[] = []
    let h: RedisHarness
    const harness = (options?: RedisLoaderUtilsOptions) => {
      const made = make(options)
      open.push(made)
      return made
    }
    beforeEach(async () => {
      await seed()
      h = harness()
    })
    afterAll(async () => {
      await Promise.all(open.map((o) => o.close()))
    })

    it('get batches into one MGET and decodes JSON', async () => {
      const loader = h.utils.get('loader-utils-test:user:{id}')
      const [a, b, missing] = await Promise.all([loader.load(1), loader.load(2), loader.load(99)])
      expect(a).toEqual({ id: 1, name: 'ada' })
      expect(b).toEqual({ id: 2, name: 'bob' })
      expect(missing).toBeNull()
      expect(h.mgetCalls()).toBe(1)
    })

    it('fetches each distinct key once even with cache: false', async () => {
      h = harness({ cache: false })
      const mget = vi.spyOn(h.utils.adapter, 'mget')
      const loader = h.utils.get('loader-utils-test:user:{id}')
      const users = await Promise.all([
        loader.load(1),
        loader.load(1),
        loader.load('1'),
        loader.load(2),
      ])
      expect(users.map((u) => u?.id)).toEqual([1, 1, 1, 2])
      expect(mget).toHaveBeenCalledTimes(1)
      expect(mget.mock.calls[0]?.[0]).toEqual([
        'loader-utils-test:user:1',
        'loader-utils-test:user:2',
      ])
      expect(h.mgetCalls()).toBe(1)
    })

    it('a value that fails to decode rejects only its key', async () => {
      const loader = h.utils.get('loader-utils-test:user:{id}')
      const [ok, bad] = await Promise.allSettled([loader.load(1), loader.load(3)])
      expect(ok).toMatchObject({ status: 'fulfilled', value: { id: 1 } })
      expect(bad).toMatchObject({ status: 'rejected', reason: expect.any(SyntaxError) })
    })

    it('supports a custom decoder', async () => {
      h = harness({ decode: (raw, key) => `${key}=${raw}` })
      expect(await h.utils.get('loader-utils-test:user:{id}').load(3)).toBe(
        'loader-utils-test:user:3=not json',
      )
    })

    it('hash returns the whole hash or null', async () => {
      const loader = h.utils.hash('loader-utils-test:profile:{id}')
      const [p1, none] = await Promise.all([loader.load(1), loader.load(99)])
      expect(p1).toEqual({ email: 'ada@example.com', age: '36' })
      expect(none).toBeNull()
    })

    it('hashField returns one field or null', async () => {
      const loader = h.utils.hashField('loader-utils-test:profile:{id}', 'email')
      expect(await Promise.all([loader.load(1), loader.load(99)])).toEqual([
        'ada@example.com',
        null,
      ])
    })

    it('members returns set members or []', async () => {
      const loader = h.utils.members('loader-utils-test:followers:{id}')
      const [f1, none] = await Promise.all([loader.load(1), loader.load(99)])
      expect(f1.sort()).toEqual(['2', '3'])
      expect(none).toEqual([])
    })

    it('builds keys and names loaders by operation and pattern', () => {
      expect(h.utils.key('loader-utils-test:user:{id}', 7)).toBe('loader-utils-test:user:7')
      const loader = h.utils.get('loader-utils-test:user:{id}')
      expect(loader.name).toBe('get:loader-utils-test:user:{id}')
      expect(h.utils.get('loader-utils-test:user:{id}')).toBe(loader)
      expect(h.utils.hashField('loader-utils-test:profile:{id}', 'age').name).toBe(
        'hget:loader-utils-test:profile:{id}.age',
      )
      h.utils.dispose()
      expect(h.utils.loaders.size).toBe(0)
    })
  })
}
