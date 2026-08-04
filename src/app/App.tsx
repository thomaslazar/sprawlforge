import { useEffect, useMemo, useState } from 'react'
import { generateSector } from '../gen/sector/generate'
import { hashSeed } from '../gen/rng'
import type { SectorParams } from '../gen/types'
import { renderSector } from '../render/svg'
import { getTheme } from '../render/theme'
import { KnobPanel } from './KnobPanel'
import { MapView } from './MapView'
import { stateFromSearch, stateToSearch, type AppState } from './params'
import { resolveTags } from './tags'

// ponytail: crypto.getRandomValues is the one non-seeded random — first-visit seed only
function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]
}

export function App() {
  const [state, setState] = useState<AppState>(() =>
    stateFromSearch(window.location.search, randomSeed()),
  )

  useEffect(() => {
    window.history.replaceState(null, '', stateToSearch(state))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const update = (s: AppState) => {
    setState(s)
    window.history.replaceState(null, '', stateToSearch(s))
  }

  const params: SectorParams = useMemo(
    () => ({ seed: state.seed, pack: state.pack, theme: state.theme, ...resolveTags(state.tags) }),
    [state],
  )

  // semantic zoom: labels re-render per zoom band (1|2|4|8) so more of them
  // fit as you zoom in; generation itself only depends on params
  const [labelZoom, setLabelZoom] = useState(1)
  const model = useMemo(() => generateSector(params), [params])
  const svg = useMemo(
    () => renderSector(model, getTheme(params.theme), { labelZoom }),
    [model, params.theme, labelZoom],
  )

  const exportName = `sprawlforge-sector-${params.seed}`
  // ponytail: jspdf pulls ~688kB into the main chunk — defer the whole
  // exports module to the click that actually needs it
  const onExport = async (kind: 'svg' | 'png' | 'pdf') => {
    const m = await import('./exports')
    // exports always use base label sizing, independent of viewport zoom
    const exportSvg = renderSector(model, getTheme(params.theme))
    switch (kind) {
      case 'svg':
        m.downloadSvg(exportSvg, exportName)
        break
      case 'png':
        await m.downloadPng(exportSvg, 2, exportName)
        break
      case 'pdf':
        await m.downloadPdf(exportSvg, exportName)
        break
    }
  }

  return (
    <div style={{ display: 'flex', height: '100vh', margin: 0 }}>
      <KnobPanel
        state={state}
        onChange={update}
        onReroll={() => update({ ...state, seed: hashSeed(state.seed, 'reroll') })}
        onExport={onExport}
      />
      <MapView
        svg={svg}
        onZoom={(z) => setLabelZoom(Math.min(8, Math.max(1, 2 ** Math.floor(Math.log2(z)))))}
      />
    </div>
  )
}
