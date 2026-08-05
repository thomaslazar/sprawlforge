import type { SectorParams } from '../gen/types'

export const TAG_GROUPS = {
  terrain: ['inland', 'coastal', 'bay', 'island'],
  size: ['small', 'medium', 'large'],
  density: ['sparse', 'dense', 'packed'],
  power: ['corp-run', 'balanced', 'fringe'],
  activity: ['quiet', 'lively'],
} as const

export type TagGroup = keyof typeof TAG_GROUPS
// river/lakes/piers are free toggles: independently selectable, no group,
// no exclusion — see normalizeTags.
export const FREE_TAGS = ['river', 'lakes', 'piers'] as const
export type Tag = (typeof TAG_GROUPS)[TagGroup][number] | (typeof FREE_TAGS)[number]

/** numeric/param effect of each tag; absent group = default values */
const TAG_EFFECTS: Record<string, Partial<SectorParams>> = {
  inland: { landform: 'inland' }, coastal: { landform: 'coastal' },
  bay: { landform: 'bay' }, island: { landform: 'island' },
  small: { size: 2 }, medium: { size: 4 }, large: { size: 6 },
  sparse: { density: 0.25 }, dense: { density: 0.6 }, packed: { density: 0.9 },
  'corp-run': { corpDominance: 0.85 }, balanced: { corpDominance: 0.5 }, fringe: { corpDominance: 0.15 },
  quiet: { poiDensity: 0.25 }, lively: { poiDensity: 0.7 },
  river: { river: true }, lakes: { lakes: true }, piers: { piers: true },
}

export const DEFAULT_PARAMS: Omit<SectorParams, 'seed' | 'pack' | 'theme'> = {
  landform: 'auto', river: false, lakes: false,
  size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5, piers: false,
}

/** last tag of a group wins; unknown tags are ignored */
export function resolveTags(tags: string[]): Omit<SectorParams, 'seed' | 'pack' | 'theme'> {
  return tags.reduce(
    (acc, tag) => ({ ...acc, ...(TAG_EFFECTS[tag] ?? {}) }),
    { ...DEFAULT_PARAMS },
  )
}

/** normalize: keep at most one tag per group (last wins), keep free toggles */
export function normalizeTags(tags: string[]): Tag[] {
  const picked = new Map<string, Tag>()
  const free = new Set<Tag>()
  for (const tag of tags) {
    if ((FREE_TAGS as readonly string[]).includes(tag)) { free.add(tag as Tag); continue }
    for (const [group, members] of Object.entries(TAG_GROUPS))
      if ((members as readonly string[]).includes(tag)) picked.set(group, tag as Tag)
  }
  return [...picked.values(), ...free]
}
