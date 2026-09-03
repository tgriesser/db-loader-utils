import { createClient } from 'redis'
import { vi } from 'vitest'
import { NodeRedisLoaderUtils } from '../src/redis'
import { REDIS_URL, runRedisSuite, type Schema } from './redis-suite'

runRedisSuite('node-redis', (options) => {
  const client = createClient({ url: REDIS_URL })
  const connected = client.connect()
  const mGet = vi.spyOn(client, 'mGet')
  return {
    utils: new NodeRedisLoaderUtils<Schema>(client, options),
    mgetCalls: () => mGet.mock.calls.length,
    close: async () => {
      await connected
      await client.close()
    },
  }
})
