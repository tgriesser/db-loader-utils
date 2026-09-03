# db-loader-utils: initial structure

Repo has no commits yet, so work stays on `main`.

## Goal

`@tgriesser/db-loader-utils` — DataLoader boilerplate for kysely & knex, with
subpath entrypoints (`/knex`, `/kysely`). All loaders live in a `Map` on the
instance so they can be cleared/disposed together.

## Plan

- [x] Core (`src/core/`): `DBLoaderUtils` class holding the loader map, get-or-create
      `loader(key, batchFn)`, `clearAll()`, `dispose()`, and the shared
      byColumn / manyByColumn / pick / single / join / count / sum methods built
      on a small `Adapter` interface (select / selectJoin / aggregate).
- [x] Typed scopes per adapter via a `QueryBuilderKind` HKT-style hook so kysely
      scopes are `SelectQueryBuilder<DB, T, {}>` for the right table.
- [x] `src/knex.ts`: `KnexLoaderUtils<DB>` adapter.
- [x] `src/kysely.ts`: `KyselyLoaderUtils<DB>` adapter (rows are `Selectable<DB[T]>`).
- [x] package.json exports map (`.`, `./knex`, `./kysely`), tsup build, peerDeps optional.
- [x] Integration tests with better-sqlite3 against both adapters + typecheck.
- [x] README with usage.

- [x] Scopes as define-once objects (`defineScope`) with a registry that rejects a
      different definition under the same name; parameterized via `.with(...)`.
- [x] `cache` constructor option passed to every loader.
- [x] Prettier (no semi, single quote) + husky/lint-staged pre-commit.

## Review

- `pnpm typecheck` clean (src + test, incl. `test/types.test-d.ts` compile-time assertions).
- `pnpm test`: 32 tests, same suite run against knex and kysely on better-sqlite3.
- `pnpm build`: ESM + CJS + d.ts for `.`, `./knex`, `./kysely`; verified a consumer
  importing `dist/kysely` keeps per-table scope typing.
- Gotcha: `typescript@7` (native) breaks tsup's dts bundling; pinned to `^5`.
- Not committed (per instructions).
