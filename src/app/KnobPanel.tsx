import { packs } from '../gen/names/packs'
import { themes } from '../render/theme'
import type { AppState } from './params'
import { t } from './strings'
import { TAG_GROUPS, type Tag, type TagGroup } from './tags'

interface Props {
  state: AppState
  onChange: (s: AppState) => void
  onReroll: () => void
  onExport: (kind: 'svg' | 'png' | 'pdf') => void
}

function Chip({ label, pressed, onClick }: { label: string; pressed: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      style={{
        padding: '4px 10px',
        marginRight: 6,
        marginBottom: 6,
        borderRadius: 999,
        border: '1px solid #888',
        background: pressed ? '#4a4af0' : 'transparent',
        color: pressed ? '#fff' : 'inherit',
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  )
}

export function KnobPanel({ state, onChange, onReroll, onExport }: Props) {
  const setSeed = (seed: number) => onChange({ ...state, seed })
  const setPack = (pack: string) => onChange({ ...state, pack })
  const setTheme = (theme: string) => onChange({ ...state, theme })

  const toggleTag = (group: TagGroup, tag: Tag) => {
    const active = state.tags.includes(tag)
    const withoutGroup = state.tags.filter((tg) => !(TAG_GROUPS[group] as readonly string[]).includes(tg))
    onChange({ ...state, tags: active ? withoutGroup : [...withoutGroup, tag] })
  }

  const togglePiers = () => {
    const active = state.tags.includes('piers')
    onChange({ ...state, tags: active ? state.tags.filter((tg) => tg !== 'piers') : [...state.tags, 'piers'] })
  }

  return (
    <div style={{ width: 260, padding: 16, overflowY: 'auto' }}>
      <h1 style={{ fontSize: 18 }}>{t.appTitle}</h1>
      <h2 style={{ fontSize: 14, opacity: 0.7 }}>{t.toolTitle}</h2>
      <button onClick={onReroll} style={{ width: '100%', padding: 8, margin: '12px 0' }}>
        {t.knobs.reroll}
      </button>
      <label style={{ display: 'block', marginBottom: 12 }}>
        {t.knobs.seed}
        <input
          type="number"
          value={state.seed}
          onChange={(e) => setSeed(Number(e.target.value) >>> 0)}
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
                pressed={state.tags.includes(tag)}
                onClick={() => toggleTag(group, tag)}
              />
            ))}
          </div>
        </div>
      ))}
      <div style={{ marginBottom: 12 }}>
        <div style={{ marginBottom: 4 }}>{t.tagGroups.piers}</div>
        <Chip label={t.tags.piers} pressed={state.tags.includes('piers')} onClick={togglePiers} />
      </div>
      <label style={{ display: 'block', marginBottom: 12 }}>
        {t.knobs.pack}
        <select value={state.pack} onChange={(e) => setPack(e.target.value)} style={{ width: '100%' }}>
          {Object.values(packs).map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
      </label>
      <label style={{ display: 'block', marginBottom: 12 }}>
        {t.knobs.theme}
        <select value={state.theme} onChange={(e) => setTheme(e.target.value)} style={{ width: '100%' }}>
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
