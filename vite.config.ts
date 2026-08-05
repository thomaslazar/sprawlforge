import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: './',
  plugins: [react()],
  test: {
    // forks instead of worker threads: the CPU-heavy terrain smoke sweep
    // starves the threads-pool RPC on slow CI runners ("Timeout calling
    // onTaskUpdate" with all tests green)
    pool: 'forks',
    // the multi-seed terrain sweep takes minutes — excluded from the default
    // fast loop; `npm run test:all` (used by CI) includes it
    exclude: ['**/node_modules/**', '**/smoke.test.ts'],
  },
})
