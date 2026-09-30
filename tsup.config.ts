import { defineConfig } from 'tsup'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/knex.ts',
    'src/kysely.ts',
    'src/knex-table-utils.ts',
    'src/kysely-table-utils.ts',
    'src/ioredis.ts',
    'src/redis.ts',
  ],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ['knex', 'kysely', 'ioredis', 'redis', 'dataloader'],
})
