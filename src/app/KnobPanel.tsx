import { useEffect, useState } from 'react'
import { packs } from '../gen/names/packs'
import { themes } from '../render/theme'
import type { AppState } from './params'
import { t } from './strings'
import { TAG_GROUPS, type Tag, type TagGroup } from './tags'

// river/lakes/islands/piers: free toggles, no exclusion — presented together
// as a water-themed chip row (piers is water-themed too: harbor decor).
const WATER_TAGS: Tag[] = ['river', 'lakes', 'islands', 'piers']
// activity-adjacent free toggle rendered with the activity group
const NO_POIS: Tag = 'no-pois'

interface Props {
  applied: AppState
  pendingTags: Tag[]
  busy: boolean
  onChange: (s: AppState) => void
  onPendingTagsChange: (tags: Tag[]) => void
  onReroll: () => void
  onExport: (kind: 'svg' | 'png' | 'pdf') => void
}

// two independent visual channels: `pending` (staged chip selection, darker
// fill) and `applied` (what the visible map was actually built with, a
// lighter ring) — they can disagree until the next Reroll.
function Chip({
  label,
  pending,
  applied,
  onClick,
  disabled,
  title,
}: {
  label: string
  pending: boolean
  applied: boolean
  onClick: () => void
  disabled?: boolean
  title?: string
}) {
  return (
    <button
      type="button"
      aria-pressed={pending}
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        padding: '4px 10px',
        marginRight: 6,
        marginBottom: 6,
        borderRadius: 999,
        border: '1px solid #888',
        boxShadow: applied ? '0 0 0 2px #9fd8ff' : 'none',
        background: pending ? '#2323a0' : 'transparent',
        color: pending ? '#fff' : 'inherit',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {label}
    </button>
  )
}

export function KnobPanel({ applied, pendingTags, busy, onChange, onPendingTagsChange, onReroll, onExport }: Props) {
  const setPack = (pack: string) => onChange({ ...applied, pack })
  const setTheme = (theme: string) => onChange({ ...applied, theme })

  // seed regenerates the map (expensive) — apply on commit only, not per keystroke
  const [seedInput, setSeedInput] = useState(String(applied.seed))
  useEffect(() => setSeedInput(String(applied.seed)), [applied.seed])
  const commitSeed = () => {
    const seed = Number(seedInput) >>> 0
    if (seed !== applied.seed) onChange({ ...applied, seed })
  }

  const isDry = (tags: Tag[]): boolean =>
    tags.includes('inland') && !tags.includes('river') && !tags.includes('lakes')
  // piers need water — auto-unstage a staged piers chip the moment the
  // staged combo goes explicitly dry (inland, no river, no lakes)
  const dryGate = (tags: Tag[]): Tag[] => (isDry(tags) ? tags.filter((tg) => tg !== 'piers') : tags)

  const toggleTag = (group: TagGroup, tag: Tag) => {
    const active = pendingTags.includes(tag)
    const withoutGroup = pendingTags.filter((tg) => !(TAG_GROUPS[group] as readonly string[]).includes(tg))
    const next = active ? withoutGroup : [...withoutGroup, tag]
    onPendingTagsChange(dryGate(next))
  }

  const toggleWaterTag = (tag: Tag) => {
    const active = pendingTags.includes(tag)
    const next = active ? pendingTags.filter((tg) => tg !== tag) : [...pendingTags, tag]
    onPendingTagsChange(dryGate(next))
  }

  const piersDisabled = isDry(pendingTags)

  return (
    <div style={{ width: 260, padding: 16, overflowY: 'auto' }}>
      <h1 style={{ fontSize: 18 }}>{t.appTitle}</h1>
      <h2 style={{ fontSize: 14, opacity: 0.7 }}>{t.toolTitle}</h2>
      <button onClick={onReroll} disabled={busy} style={{ width: '100%', padding: 8, margin: '12px 0' }}>
        {busy ? t.knobs.rerolling : t.knobs.reroll}
      </button>
      <label style={{ display: 'block', marginBottom: 12 }}>
        {t.knobs.seed}
        <input
          type="number"
          value={seedInput}
          onChange={(e) => setSeedInput(e.target.value)}
          onBlur={commitSeed}
          onKeyDown={(e) => e.key === 'Enter' && commitSeed()}
          style={{ width: '100%' }}
        />
      </label>
      {(Object.keys(TAG_GROUPS) as TagGroup[]).map((group) => (
        <div key={group} style={{ marginBottom: 12 }}>
          <div style={{ marginBottom: 4 }}>{t.tagGroups[group]}</div>
          <div>
            {TAG_GROUPS[group].map((tag) => (
              <Chip
                key={tag}
                label={t.tags[tag]}
                pending={pendingTags.includes(tag)}
                applied={applied.tags.includes(tag)}
                onClick={() => toggleTag(group, tag)}
              />
            ))}
            {group === 'activity' && (
              <Chip
                label={t.tags[NO_POIS]}
                pending={pendingTags.includes(NO_POIS)}
                applied={applied.tags.includes(NO_POIS)}
                onClick={() => toggleWaterTag(NO_POIS)}
              />
            )}
          </div>
        </div>
      ))}
      <div style={{ marginBottom: 12 }}>
        <div style={{ marginBottom: 4 }}>{t.tagGroups.water}</div>
        <div>
          {WATER_TAGS.map((tag) => (
            <Chip
              key={tag}
              label={t.tags[tag]}
              pending={pendingTags.includes(tag)}
              applied={applied.tags.includes(tag)}
              onClick={() => toggleWaterTag(tag)}
              disabled={tag === 'piers' ? piersDisabled : undefined}
              title={tag === 'piers' && piersDisabled ? t.tags.piersNeedsWater : undefined}
            />
          ))}
        </div>
      </div>
      <label style={{ display: 'block', marginBottom: 12 }}>
        {t.knobs.pack}
        <select value={applied.pack} onChange={(e) => setPack(e.target.value)} style={{ width: '100%' }}>
          {Object.values(packs).map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
      </label>
      <label style={{ display: 'block', marginBottom: 12 }}>
        {t.knobs.theme}
        <select value={applied.theme} onChange={(e) => setTheme(e.target.value)} style={{ width: '100%' }}>
          {Object.values(themes).map((th) => (
            <option key={th.id} value={th.id}>{th.label}</option>
          ))}
        </select>
      </label>
      <div style={{ display: 'grid', gap: 8, marginTop: 16 }}>
        <button onClick={() => onExport('svg')}>{t.exports.svg}</button>
        <button onClick={() => onExport('png')}>{t.exports.png}</button>
        <button onClick={() => onExport('pdf')}>{t.exports.pdf}</button>
      </div>
    </div>
  )
}
