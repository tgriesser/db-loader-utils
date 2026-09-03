import {
  RedisLoaderUtils,
  toError,
  type RedisAdapter,
  type RedisLoaderUtilsOptions,
  type Reply,
} from './core/redis-loader-utils'

export * from './index'

/** The subset of a node-redis client we use; `createClient()` instances satisfy it. */
export interface NodeRedisClient {
  mGet(keys: string[]): Promise<Array<string | null>>
  hGetAll(key: string): Promise<Record<string, string>>
  hGet(key: string, field: string): Promise<string | null | undefined>
  sMembers(key: string): Promise<string[]>
}

/**
 * node-redis pipelines commands issued in the same tick automatically, so each
 * batch of per-key commands goes out as one round trip.
 */
export class NodeRedisAdapter implements RedisAdapter {
  constructor(private readonly client: NodeRedisClient) {}

  mget(keys: readonly string[]) {
    return this.client.mGet(Array.from(keys))
  }

  hgetall(keys: readonly string[]) {
    return settle(keys.map((k) => this.client.hGetAll(k)))
  }

  hget(keys: readonly string[], field: string) {
    return settle(keys.map((k) => this.client.hGet(k, field).then((v) => v ?? null)))
  }

  smembers(keys: readonly string[]) {
    return settle(keys.map((k) => this.client.sMembers(k)))
  }
}

function settle<T>(promises: Promise<T>[]): Promise<Reply<T>[]> {
  return Promise.all(promises.map((p) => p.catch(toError)))
}

export class NodeRedisLoaderUtils<S> extends RedisLoaderUtils<S> {
  constructor(
    readonly client: NodeRedisClient,
    options?: RedisLoaderUtilsOptions,
  ) {
    super(new NodeRedisAdapter(client), options)
  }
}

export default NodeRedisLoaderUtils
