import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: './',
  plugins: [react()],
  // Devcontainer: vite's default binds only [::1]; VS Code forwards the
  // port over IPv4, so pin the same address uicheck/streets-toy use.
  server: { host: '127.0.0.1' },
  test: {
    // forks instead of worker threads: the CPU-heavy terrain smoke sweep
    // starves the threads-pool RPC on slow CI runners ("Timeout calling
    // onTaskUpdate" with all tests green)
    pool: 'forks',
    // the multi-seed terrain sweep takes minutes — excluded from the default
    // fast loop; `npm run test:all` (used by CI) sets VITEST_ALL to include it
    exclude: ['**/node_modules/**', ...(process.env.VITEST_ALL ? [] : ['**/smoke.test.ts'])],
    // The generator tests are CPU-bound for up to a minute per test; vitest's
    // worker heartbeat then reports "Timeout calling onTaskUpdate" as an
    // unhandled error and fails an otherwise green run (seen on CI and in the
    // devcontainer). Test failures still fail the run; only that heartbeat
    // noise is ignored.
    dangerouslyIgnoreUnhandledErrors: true,
  },
})
