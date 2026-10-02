# Cyberpunk Layer, Part 1: Arcologies and Megablocks — Design

Status: approved in brainstorm, spec for review
Branch: `spec/cyberpunk-layer`
Depends on: `docs/specs/2026-09-29-tensor-streets-design.md` (merged, PR #6)
Deferred to part 2 (user wants both): highway frontage strips, walled
corporate compounds.

## 1. Goal

Make a sector read as cyberpunk at a glance: a few giant corporate
**arcologies** that the street net bends toward, and solid slum
**megablocks** with no streets inside. Both are landmarks: named, marked
as POIs, drawn distinctly in every theme, exported like everything else.

## 2. Decisions

1. **Landmarks are placed before roads.** Arcologies and megablocks are
   chosen right after the highway is traced, so roads can react to them
   (bend toward arcologies, stop at megablocks). No post-hoc merging of
   blocks.
2. **One obstacle mechanism.** The tracer gets an `obstacles` list of
   polygons it treats like water (a streamline stops at the edge). Arcology
   plazas block every road class; megablock cores block streets only.
3. **Arcologies shape the field.** A `radial` basis field around each
   arcology (the `extra` hook in `buildRoadField`) makes the major axis
   point at the centre, so arterials arrive as spokes and streets wrap as
   rings. A **ring road** (arterial, closed polyline) around the plaza is
   added before arterial tracing and seeds spokes.
4. **Counts follow the power tag.** `corp-run` → 2-3 arcologies, 0-1
   megablocks; `balanced` → 1-2 / 1-2; `fringe` → 0-1 / 2-4. Sectors of
   2 km get at most one of each. Rng stream `'landmarks'`.
5. **Zoning respects landmarks.** A district face containing an arcology
   centre is zoned `corp`; one containing a megablock core is zoned
   `slum`.
6. **Data model.** New `Arcology` and `Megablock` records on the model;
   `District.flags` / `Block.flags` become
   `Partial<{ arcology: string; megablock: string }>` (the reserved hook).
7. Flavor packs gain `arcologyPatterns` and `megablockPatterns`; POI types
   `arcology` and `megablock` are placed at the landmark centres (one each)
   in addition to the normal POI lottery.

## 3. Placement (`src/gen/landmarks/place.ts`)

Inputs: params, terrain, sizeM, highway polyline (may be absent).

- Candidate points: a jittered 300 m lattice over land, ≥ 350 m from the
  window edge, ≥ 150 m from water, ≥ 250 m from the highway centreline.
- Arcologies: pick `n` candidates greedily with mutual distance ≥ 900 m,
  preferring the candidate farthest from already chosen ones (first pick
  nearest the sector centre). Radius `r` = 100-180 m (rng). Footprint =
  regular octagon of radius `r`, rotated by the local field major angle.
  Plaza = octagon of radius `r + 40`. Ring road = circle of radius
  `r + 60`, 48 segments, class `arterial`, width 18, id `K<n>`.
- Megablocks: pick `m` candidates ≥ 700 m from every arcology and from
  each other, preferring high `effectiveIrregularity` (slum-leaning).
  Core = irregular octagon with radii 150-250 m (each vertex radius
  jittered ±20 %), rotated to the local field. Megablocks have no ring
  road.
- Output: `{ arcologies: Arcology[]; megablocks: Megablock[] }` with
  `Arcology { id: 'ARC1'…, center, radius, footprint, plaza, ringRoadId }`
  and `Megablock { id: 'MEG1'…, center, core }`.

## 4. Field and tracing changes

- `radialBasis(center, rInner, rOuter)`: angle = direction from `p` to
  `center` (as a line angle); weight 1.5 at `rInner = r + 60` falling
  linearly to 0 at `rOuter = 800` m; 0 inside `rInner`. One per arcology,
  appended via `extra`. Weight 1.5 beats the grid (1) so spokes win near
  the arcology and blend out by 800 m.
- `TraceOpts.obstacles?: Pt[][]`: in `traceHalf`, `next` inside any
  obstacle stops the half like water. Arterial passes get the plazas;
  street passes get plazas and megablock cores. `poissonSeeds` and
  `seedsAlong` filter seeds inside obstacles.
- Ring roads are added to the `RoadIndex` before arterials (like the
  highway), and `seedsAlong(ring, 400, false)` seeds are added to the
  arterial seed list with `crossingAxis`, so spokes leave the ring.
- `pruneDangling` accepts ring roads as anchors (they are arterials).
- Infill (`infillFaces`) skips faces that contain an arcology centre or a
  megablock core, and measures the rest of a megablock's face minus the
  core.

## 5. Faces, zoning, lots

- District faces: the face containing an arcology centre is the arcology
  block (the ring road encloses it). `assignZones` gets
  `forced: Array<{ at: Pt; zone: ZoneType }>` and uses it before the
  lottery. `District.flags.arcology = id` / `.megablock = id` on the
  district that contains the landmark.
- Blocks inside the arcology plaza get `flags.arcology` and produce **no
  lots**; the arcology itself is not a `Building` (buildings are POI
  anchors; the arcology gets its own POI). Blocks whose face contains a
  megablock core get `flags.megablock`; `fillLots` emits ONE building
  for the core (core inset by 3 m, concave allowed) with `style`
  `'megablock'` on the block, alleys from a BSP of the core at 60 m cells
  (drawn like other alleys), and normal lots for the rest of the face
  (the core is a no-build strip for them).
- `BlockStyle` gains `'megablock'`.

## 6. Names and POIs

- `FlavorPack.arcologyPatterns` (e.g. `'{corpA} Arcology'`,
  `'{corpA}-{corpB} Spire'`) and `megablockPatterns` (e.g.
  `'{place} Block'`, `'The {adj} Hive'`); both packs get 4+ patterns.
- `Arcology.name` / `Megablock.name` drawn from the `'names'` stream after
  districts.
- POI types `arcology` (zones `['corp']`) and `megablock` (zones
  `['slum']`) exist in both packs; `placePois` adds one POI per landmark
  at its centre with the landmark's name, before the lottery, and the
  lottery never places a POI inside an arcology plaza.

## 7. Rendering

- Theme gains `arcology: { fill: string; stroke: string; ring: string }`
  and `megablock: { fill: string; alley: string }`; all five themes.
- Arcology: plaza filled with `districtFill.corp` lightened; footprint
  octagon filled `arcology.fill`, stroked `arcology.stroke` 2 px, plus two
  concentric inner octagons at 0.66 r and 0.33 r stroked `arcology.ring`
  1 px. Drawn after buildings, before roads. `data-arcology="ARC1"`.
- Megablock: the core building filled `megablock.fill`, alleys in
  `megablock.alley` at 0.6 opacity. `data-megablock="MEG1"` on the core
  polygon.
- Labels: landmark names render like district labels (same font, one
  size larger), placed at the centre, always shown (they are few).
- Interactive batching: landmarks are few; individual elements are fine.

## 8. Data model

```ts
export interface Arcology {
  id: string; name: string; center: Pt; radius: number
  footprint: Pt[]; plaza: Pt[]; ringRoadId: string
}
export interface Megablock { id: string; name: string; center: Pt; core: Pt[] }
export type LandmarkFlags = Partial<{ arcology: string; megablock: string }>
// District.flags, Block.flags: LandmarkFlags
export type BlockStyle = 'rows' | 'courtyard' | 'plaza' | 'sheds' | 'megablock'
// SectorModel gains arcologies: Arcology[]; megablocks: Megablock[]
```

`GENERATOR_VERSION` becomes 6 (PR #6 shipped version 5; same seed now
renders a different map).

## 9. Tests

- Placement: determinism; counts per power tag on seeds 42 / 7 / 1443928265
  × inland/coastal/bay; every landmark ≥ 150 m from water, ≥ 250 m from
  the highway, arcologies ≥ 900 m apart.
- Tracing: no road point inside an arcology plaza; no street point inside
  a megablock core; every ring road is closed (first ≈ last) and at least
  4 arterials end on it (spokes); `every land block is street-sized`
  exempts landmark faces.
- Zoning/lots: the arcology district is `corp`; no building inside a
  plaza; exactly one building per megablock core; alleys present on it.
- Names/POIs: one `arcology` POI per arcology, one `megablock` POI per
  megablock, names non-empty; no other POI inside a plaza.
- Render: `[data-arcology]` and `[data-megablock]` present on a corp-run
  / fringe seed; every theme has the new keys.
- uicheck: on a `corp-run` seed ≥ 1 `[data-arcology]`, on a `fringe` seed
  ≥ 1 `[data-megablock]`; screenshots looked at.
- Perf: within +10 % of main on seed 42 coastal+river 4 km.

## 10. Out of scope → part 2 / ROADMAP

- Highway frontage strips (C) and walled corporate compounds (D).
- Arcology interiors, bridges between arcologies, skyway layer.
- Megablock internal courtyards; megablocks spanning arterials.
