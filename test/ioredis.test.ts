import Redis from 'ioredis'
import { IoredisLoaderUtils } from '../src/ioredis'
import { REDIS_URL, runRedisSuite, type Schema } from './redis-suite'

runRedisSuite('ioredis', (options) => {
  const redis = new Redis(REDIS_URL)
  let mgets = 0
  const mget = redis.mget.bind(redis)
  redis.mget = ((...args: Parameters<typeof mget>) => {
    mgets++
    return mget(...args)
  }) as typeof redis.mget
  return {
    utils: new IoredisLoaderUtils<Schema>(redis, options),
    mgetCalls: () => mgets,
    close: () => redis.quit().then(() => undefined),
  }
})
