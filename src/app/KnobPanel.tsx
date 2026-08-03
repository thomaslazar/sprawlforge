import type { SectorParams } from '../gen/types'
import { packs } from '../gen/names/packs'
import { themes } from '../render/theme'
import { t } from './strings'

interface Props {
  params: SectorParams
  onChange: (p: SectorParams) => void
  onReroll: () => void
}

function Slider(props: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
}) {
  return (
    <label style={{ display: 'block', marginBottom: 12 }}>
      {props.label}: {props.value}
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
        style={{ width: '100%' }}
      />
    </label>
  )
}

export function KnobPanel({ params, onChange, onReroll }: Props) {
  const set = <K extends keyof SectorParams>(key: K, value: SectorParams[K]) =>
    onChange({ ...params, [key]: value })

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
          value={params.seed}
          onChange={(e) => set('seed', Number(e.target.value) >>> 0)}
          style={{ width: '100%' }}
        />
      </label>
      <Slider label={t.knobs.size} value={params.size} min={2} max={8} step={1} onChange={(v) => set('size', v)} />
      <Slider label={t.knobs.density} value={params.density} min={0} max={1} step={0.1} onChange={(v) => set('density', v)} />
      <Slider label={t.knobs.corpDominance} value={params.corpDominance} min={0} max={1} step={0.1} onChange={(v) => set('corpDominance', v)} />
      <Slider label={t.knobs.poiDensity} value={params.poiDensity} min={0} max={1} step={0.1} onChange={(v) => set('poiDensity', v)} />
      <label style={{ display: 'block', marginBottom: 8 }}>
        <input type="checkbox" checked={params.coast} onChange={(e) => set('coast', e.target.checked)} /> {t.knobs.coast}
      </label>
      <label style={{ display: 'block', marginBottom: 12 }}>
        <input type="checkbox" checked={params.river} onChange={(e) => set('river', e.target.checked)} /> {t.knobs.river}
      </label>
      <label style={{ display: 'block', marginBottom: 12 }}>
        {t.knobs.pack}
        <select value={params.pack} onChange={(e) => set('pack', e.target.value)} style={{ width: '100%' }}>
          {Object.values(packs).map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
      </label>
      <label style={{ display: 'block', marginBottom: 12 }}>
        {t.knobs.theme}
        <select value={params.theme} onChange={(e) => set('theme', e.target.value)} style={{ width: '100%' }}>
          {Object.values(themes).map((th) => (
            <option key={th.id} value={th.id}>{th.label}</option>
          ))}
        </select>
      </label>
    </div>
  )
}
