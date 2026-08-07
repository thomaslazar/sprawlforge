# SprawlForge Architecture

A map, not a diary — bird's-eye structure, code map, invariants. Details
live in the code and in `docs/specs/`.

## What this is

Client-only React + vite app (no backend, no accounts) that procedurally
generates cyberpunk sector maps as SVG. Everything is **deterministic**:
the same seed + tags always produce byte-identical output, across
sessions and machines. Deployed to GitHub Pages on every push to `main`
(`.github/workflows/deploy.yml`, live ~3 min later).

## The generation pipeline

`generateSector(params)` in `src/gen/sector/generate.ts` runs these
stages in order. Each stage draws randomness from its own
`mulberry32(hashSeed(seed, '<stage>'))` stream, so stages never disturb
each other.

| # | Stage | Where | What it produces |
|---|-------|-------|------------------|
| 1 | Terrain | `src/gen/terrain/` | Metro-scale heightfield (noise + landform gradient, `field.ts`), carved river (`rivers.ts`), lake dips, islet bumps with moats; marching-squares contouring (`contour.ts`) → `water`/`land` multipolygons + `riverSlice` |
| 2 | District domains | `sector/roads.ts` `districtDomains` | Land outer rings ∪ river corridor (banks reconnect so cuts crossing the river become bridges), lakes filled in, clamped to the sector window |
| 3 | Districts + arterials | `roads.ts` `partitionDistricts` | Highway corridor split, then twisted bisection → district polygons; the cuts *are* the arterial polylines |
| 4 | Zoning | `sector/zoning.ts` `assignZones` | Zone lottery weighted by `corpDominance` + shore; per-district `irregularity` = spatial field ×0.7 + zone base ×0.3 + jitter |
| 5 | Streets + blocks | `roads.ts` `layoutStreets` | Per-district twisted bisection → street polylines + block polygons |
| 6 | Road finishing | `roads.ts` `finalizeRoads` → `bridges.ts` | Overpass joins, water clipping, over-span/unlandable truncation, bridge planning — all arc-length parameterized over polylines |
| 7 | Buildings | `sector/buildings.ts` | Per block: rotated rect-BSP lot grid, every lot clipped to block footprint ∩ land |
| 8 | Names, POIs, piers | `generate.ts`, `names/`, `pois.ts`, `piers.ts` | Labels, POI placement (zone-filtered types), dock piers |
| 9 | Render | `src/render/svg.ts` + `theme.ts` | One SVG string; themes are pure palettes |

### The partitioner (the heart)

`src/gen/partition/twisted.ts` — recursive **twisted bisection** of an
arbitrary polygon. One continuous `irregularity` parameter (0..1) sweeps
the output from a true BSP-style grid (≤0.15) to multi-hump meandering
organic fabric (0.9+): axis snapping fades out, cuts subdivide and
wander (midpoint displacement + Chaikin smoothing), bends meet the
boundary near-perpendicular. Cuts split with a corridor polygon +
`polygon-clipping` difference. Cells are **never merged across
parents** — that containment is what keeps the algorithm stable.
`PolyCut.depth` records recursion depth → road width hierarchy
(avenue 24 m / arterial 18 / connector 14; street 9 / lane 6).

`src/gen/partition/irregularity.ts` — a low-frequency, contrast-stretched
noise **field** over the sector. One field per map (seeded
`hashSeed(seed,'irregularity-field')`, shifted by the streets tag) is
sampled per cut and per district by stages 3–5, so planned-grid quarters
flow into organic ones spatially, not randomly.

## The app shell (`src/app/`)

- `App.tsx` — state owner. `applied` (drives map + URL) vs `pendingTags`
  (chip staging); generation runs in a **Web Worker**
  (`genWorker.ts`) with a request-id staleness guard; render stays on
  the main thread (theme/zoom/POI-toggle re-render without regenerating).
- `tags.ts` — the tag system: exclusive groups + free toggles map to
  `SectorParams`; `materializeTags` rolls every unstaged group from the
  seed so a bare URL is a fully-decided map.
- Buttons: **Reroll** = new random seed, staged chips kept; **Update** =
  same seed, staged tags applied; **dice** = new seed, tags untouched.
- `MapView.tsx` — pan/zoom via CSS transform (`will-change`), semantic
  label zoom debounced per band.

## Invariants (do not break)

- **Determinism**: all randomness through `mulberry32(hashSeed(...))`;
  never `Math.random()`/`Date.now()` in generation. Same inputs →
  byte-identical `SectorModel`.
- **Metric only** — meters everywhere, no imperial. Ever.
- **Window containment**: every generated point lies inside
  `[0, sizeM]²`. The single choke point is the domain clamp in
  `districtDomains` (the river course deliberately carries ±500 m
  off-window margin).
- **`districts` ↔ `blocksByDistrict` are positionally 1:1** — any future
  filter between `assignZones` and `layoutStreets`/`fillBuildings`
  breaks it silently.
- **Polyline degeneracy**: the bridges/clipping pipeline must treat a
  2-point road identically to the pre-polyline code (`pointAtT` on 2
  points is plain lerp) — the old tests pin this.
- **GENERATOR_VERSION** (`src/gen/types.ts`) bumps whenever same-seed
  output changes; existing shared URLs re-render differently.
- **Toy before wiring**: partitioner changes are validated visually in
  `tools/partition-toy/` before touching `src/gen/sector/`.
- **uicheck is part of development** (`tools/uicheck/run.sh`): UI
  changes extend it in the same task; look at the screenshots, don't
  trust exit codes.

## Deliberate ceilings

Marked with greppable `ponytail:` comments at the site — the ledger of
known shortcuts (river corridor constant width, epsilon-retry unions,
islet moat overlaps, label-width estimates, …). Two structural ones:
arterial render width (24 m) exceeds the 18 m corridor gap on purpose
(cosmetic overdraw, stays inside the sidewalk inset); `polygon-clipping`
throws on numerically hard input, so booleans near geometry hot spots go
through fixed-epsilon retry wrappers (`safeUnion`/`safeIntersection`).

## Tunables (where knobs live)

| Knob | File |
|------|------|
| Zone → irregularity bias | `sector/zoning.ts` `ZONE_IRREGULARITY` |
| Zone → building size/fill | `sector/buildings.ts` `ZONE_BUILD` |
| Meander shape (amp, segments, Chaikin, thresholds) | `partition/twisted.ts` `MEANDER_*` |
| Field feature size / contrast | `partition/irregularity.ts` |
| Road widths by depth | `sector/roads.ts` |
| Islet size/moat | `terrain/field.ts` `ISLET_*` |
| Tag → param values | `app/tags.ts` `TAG_EFFECTS` |

## Repo conventions

Specs `docs/specs/YYYY-MM-DD-*.md`, plans `docs/plans/`; deferred work
lives in `docs/ROADMAP.md` (authoritative). `temp/` is gitignored
scratch. Dev-only pages under `tools/` are served by `vite dev` but
never bundled.
