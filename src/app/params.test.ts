import { describe, expect, it } from 'vitest'
import type { AppState } from './params'
import { stateFromSearch, stateToSearch } from './params'

describe('AppState codec', () => {
  it('round-trips', () => {
    const s: AppState = { seed: 4711, tags: ['coastal', 'large', 'piers'], pack: 'shadowrunish', theme: 'print' }
    expect(stateFromSearch(stateToSearch(s), 0)).toEqual(s)
  })

  it('empty search uses fallback seed and no tags', () => {
    expect(stateFromSearch('', 123)).toEqual({ seed: 123, tags: [], pack: 'generic', theme: 'neon' })
  })

  it('drops garbage tags', () => {
    const s = stateFromSearch('?seed=1&tags=nonsense,large,piers', 0)
    expect(s.tags).toEqual(['large', 'piers'])
  })

  it('ignores legacy numeric params entirely', () => {
    const s = stateFromSearch('?coast=1&density=0.7&size=8&corp=0.9&poi=0.9&terrain=coastal', 55)
    expect(s).toEqual({ seed: 55, tags: [], pack: 'generic', theme: 'neon' })
  })

  it('omits tags param from url when empty', () => {
    expect(stateToSearch({ seed: 1, tags: [], pack: 'generic', theme: 'neon' })).not.toContain('tags')
  })
})
