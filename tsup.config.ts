import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/knex.ts', 'src/kysely.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ['knex', 'kysely', 'dataloader'],
})
