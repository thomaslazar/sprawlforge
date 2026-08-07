// Module worker: takes generation off the main thread so pan/zoom stays
// responsive and CSS transitions (the busy overlay) keep animating during a
// regenerate. Deliberately typed against the ambient DOM lib (no
// `webworker` lib reference — mixing dom+webworker libs in one tsconfig
// program redeclares globals like `self`) via addEventListener/postMessage,
// which both libs agree on for the single-argument shape used here.
import { generateSector } from '../gen/sector/generate'
import type { SectorModel, SectorParams } from '../gen/types'

export interface GenRequest {
  id: number
  params: Omit<SectorParams, 'theme'>
}

export interface GenResponse {
  id: number
  model: SectorModel
}

addEventListener('message', (e: MessageEvent<GenRequest>) => {
  const { id, params } = e.data
  // theme is a render-side concern the generator never reads (see
  // SectorParams) — '' is a safe stand-in so the worker doesn't need it
  const model = generateSector({ ...params, theme: '' })
  postMessage({ id, model } satisfies GenResponse)
})
