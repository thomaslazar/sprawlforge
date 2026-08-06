import { useEffect, useMemo, useState } from 'react'
import { generateSector } from '../gen/sector/generate'
import { hashSeed } from '../gen/rng'
import type { SectorParams } from '../gen/types'
import { renderSector } from '../render/svg'
import { getTheme } from '../render/theme'
import { KnobPanel } from './KnobPanel'
import { MapView } from './MapView'
import { stateFromSearch, stateToSearch, type AppState } from './params'
import { materializeTags, resolveTags, type Tag } from './tags'

// ponytail: crypto.getRandomValues is the one non-seeded random — first-visit seed only
function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]
}

export function App() {
  // `applied` drives the visible map + URL. `pendingTags` is the chip
  // staging area — clicking a chip only ever touches this. Reroll is the
  // sole place pendingTags flows into applied (see terrain-v2 tag-staging).
  const [applied, setApplied] = useState<AppState>(() => {
    const loaded = stateFromSearch(window.location.search, randomSeed())
    return { ...loaded, tags: materializeTags(loaded.seed, loaded.tags) }
  })
  const [pendingTags, setPendingTags] = useState<Tag[]>(applied.tags)
  // generation is synchronous and blocks the main thread (~50-300ms) — stage
  // the busy label/disable on click, then let it paint before the blocking
  // work runs on the next tick
  const [busy, setBusy] = useState(false)
  const reroll = () => {
    setBusy(true)
    setTimeout(() => {
      const seed = hashSeed(applied.seed, 'reroll')
      const tags = materializeTags(seed, pendingTags)
      setPendingTags(tags)
      update({ ...applied, tags, seed })
      setBusy(false)
    }, 20)
  }

  useEffect(() => {
    window.history.replaceState(null, '', stateToSearch(applied))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const update = (s: AppState) => {
    setApplied(s)
    window.history.replaceState(null, '', stateToSearch(s))
  }

  // theme is a render-side concern only (see SectorParams) — keyed apart
  // from the generation-relevant fields so a theme switch never re-runs the
  // generator (M5: it used to regenerate the whole sector on every swap)
  const genParams = useMemo(
    () => ({ seed: applied.seed, pack: applied.pack, ...resolveTags(applied.tags) }),
    [applied.seed, applied.pack, applied.tags],
  )
  const params: SectorParams = useMemo(
    () => ({ ...genParams, theme: applied.theme }),
    [genParams, applied.theme],
  )

  // semantic zoom: labels re-render per zoom band (1|2|4|8) so more of them
  // fit as you zoom in; generation itself only depends on genParams
  const [labelZoom, setLabelZoom] = useState(1)
  const model = useMemo(() => generateSector(params), [genParams])
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
        applied={applied}
        pendingTags={pendingTags}
        busy={busy}
        onChange={update}
        onPendingTagsChange={setPendingTags}
        onReroll={reroll}
        onExport={onExport}
      />
      <MapView
        svg={svg}
        onZoom={(z) => setLabelZoom(Math.min(8, Math.max(1, 2 ** Math.floor(Math.log2(z)))))}
      />
    </div>
  )
}
