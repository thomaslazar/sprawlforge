import { describe, expect, it } from 'vitest'
import type { SectorParams } from '../types'
import { generateSector } from './generate'

// Spec budgets are for a laptop worker; PERF_SLACK scales them on slower
// hosts (e.g. PERF_SLACK=3 in the ~2x slower dev container). Skipped on CI.
const BUDGET_4KM_MS = 1500
const BUDGET_6KM_MS = 4000
// tsconfig has no node types; read env through globalThis
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}
const slack = Number(env.PERF_SLACK ?? 1)

const base: SectorParams = {
  seed: 42, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5, irregularity: 0.5,
  landform: 'coastal', river: true, lakes: false, islands: false, piers: false, arcology: false, megablock: false, pack: 'generic', theme: 'neon',
}

const timeMs = (size: number) => {
  const t = performance.now()
  generateSector({ ...base, size })
  return performance.now() - t
}

describe.skipIf(!!env.CI)('perf budget', () => {
  it('4 km within budget', () => {
    const ms = timeMs(4)
    console.log(`4 km: ${ms.toFixed(0)} ms`)
    expect(ms).toBeLessThan(BUDGET_4KM_MS * slack)
  }, 60000)
  it('6 km within budget', () => {
    const ms = timeMs(6)
    console.log(`6 km: ${ms.toFixed(0)} ms`)
    expect(ms).toBeLessThan(BUDGET_6KM_MS * slack)
  }, 60000)
})
