import DataLoader, { type BatchLoadFn } from 'dataloader'

const DEFAULT_MAX_BATCH_SIZE = 5000

export interface LoaderRegistryOptions {
  /** Upper bound on keys per batch. Default 5000. */
  maxBatchSize?: number
  /** Passed to every DataLoader. `false` keeps batching but drops per-key memoization. */
  cache?: boolean
}

/** Owns a map of DataLoaders so they can be cleared or disposed together. */
export class LoaderRegistry {
  readonly loaders = new Map<string, DataLoader<any, any, any>>()

  constructor(protected readonly options: LoaderRegistryOptions = {}) {}

  /** Get-or-create a loader by key. Custom loaders registered here are cleared/disposed with the rest. */
  loader<K, V, C = K>(
    key: string,
    batchFn: BatchLoadFn<K, V>,
    options?: DataLoader.Options<K, V, C>,
  ): DataLoader<K, V, C> {
    let loader = this.loaders.get(key) as DataLoader<K, V, C> | undefined
    if (!loader) {
      const cache = options?.cache ?? this.options.cache ?? true
      loader = new DataLoader<K, V, C>(batchFn, {
        maxBatchSize: this.options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE,
        cache,
        name: cache ? key : `${key}:nocache`,
        ...options,
      })
      this.loaders.set(key, loader)
    }
    return loader
  }

  clearAll(): this {
    for (const loader of this.loaders.values()) loader.clearAll()
    return this
  }

  dispose(): void {
    this.clearAll()
    this.loaders.clear()
  }
}
