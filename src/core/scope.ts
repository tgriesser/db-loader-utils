import type { BoundScope, BuilderFor, QueryBuilderKind, ScopeDef } from './types'

/**
 * Builds a `defineScope` bound to an adapter's builder kind. Adapters export a
 * pre-bound version, e.g. `defineScope<DB>()` from `@tgriesser/db-loader-utils/kysely`.
 */
export function createDefineScope<K extends QueryBuilderKind<any>>() {
  return function defineScope<T extends K['tables'] & string, Args extends unknown[] = []>(
    tables: T | readonly T[],
    name: string,
    scope: (qb: BuilderFor<K, T>, ...args: Args) => BuilderFor<K, T>,
  ): ScopeDef<BuilderFor<K, T>, Args> {
    const def: ScopeDef<BuilderFor<K, T>, Args> = {
      name,
      tables: typeof tables === 'string' ? [tables] : tables,
      scope,
      with: (...args) => ({
        def,
        key: args.length ? `${name}(${args.map((a) => JSON.stringify(a)).join(',')})` : name,
        apply: (qb) => scope(qb, ...args),
      }),
    }
    return def
  }
}

export function bindScope<QB>(scope: ScopeDef<QB, []> | BoundScope<QB>): BoundScope<QB> {
  return 'def' in scope ? scope : scope.with()
}
