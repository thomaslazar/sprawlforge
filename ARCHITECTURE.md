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
stages in order (design: `docs/specs/2026-09-29-tensor-streets-design.md`).
Each stage draws randomness from its own
`mulberry32(hashSeed(seed, '<stage>'))` stream, so stages never disturb
each other.

| # | Stage | Where | What it produces |
|---|-------|-------|------------------|
| 1 | Terrain | `terrain/` `sampleTerrain` | Metro-scale heightfield, carved river, lakes, islets; contouring → `water`/`land` multipolygons + `riverSlice` |
| 2 | Road field | `streets/field.ts` `buildRoadField` | Orientation patches + basis fields → `sample(p) → {major, minor}` |
| 3 | Highway | `streets/highway.ts` `traceHighway` | One highway polyline (or none if every edge is sea) |
| 3b | Landmarks | `landmarks/place.ts` `placeLandmarks` | Arcologies (7 designs; ring / half ring / boulevard / embedded), megablock cores; obstacles for the tracer |
| 3c | Frontage roads | `streets/highway.ts` `frontageRoads` | Service streets 52 m either side of elevated/ground highway stretches; strip lots between street and highway |
| 4 | Arterials | `sector/streets.ts` `traceRoads` → `streets/trace.ts` `traceLayer` | Major streamlines ~400 m apart, seeded along the highway and across the river |
| 5 | Streets pass 1 | same | Minor streamlines ~100 m apart |
| 6 | Streets pass 2 | same | Second minor pass fills gaps |
| 7 | Simplify / truncate | `sector/streets.ts`, `sector/bridges.ts` `truncateUnlandableRoads` | Simplified polylines, unlandable arterial tails cut |
| 8 | Major graph | `streets/graph.ts` `buildPlanarGraph`, `pruneDanglers` | Planar graph of highway + arterials |
| 9 | Districts | `streets/graph.ts` `facesOf`, `mergeSlivers`, `clipFacesToLand` | Faces of the major graph, clipped to land |
| 10 | Zoning | `sector/zoning.ts` `assignZones` | Zone + irregularity per district |
| 11 | Highway levels | `streets/highway.ts` `assignHighwayLevels`, `cutStreetsAtGround`, `highwayCrossings`, `buildInterchanges` | Ground/elevated/tunnel segments, crossings, ramps |
| 12 | Full graph + blocks | `sector/generate.ts` `facesFor`/`toBlocks` | Faces of highway + arterials + streets, each block tagged with `districtId` |
| 13 | Wet spans | `sector/bridges.ts` `markWetSpans` | Road spans over water flagged as bridges |
| 14 | Names | `sector/generate.ts`, `names/` | District and road names |
| 15 | Lots | `lots/index.ts` `fillLots` | Per block: setback per side, buildable piece, fabric, strip lots or whole-block layout, catalogue shapes, acceptance gate (`lots/fitbox.ts` `accepted`; a failed building leaves a filler lot); corp-district blocks become walled compounds (`landmarks/compounds.ts` `selectCompounds`) |
| 16 | Labels, POIs, piers | `sector/generate.ts` `deriveDistricts`, `sector/pois.ts`, `sector/piers.ts` | Label anchors, zone-filtered POIs, dock piers |
| 17 | Render | `src/render/svg.ts` + `theme.ts` | One SVG string; themes are pure palettes |

### The road field and tracer (the heart)

`streets/field.ts` — a tensor-style direction field: jittered **orientation
patches** (angle + size, sized from `effectiveIrregularity`, shore patches
follow the coast) blended with a basis-field list from `buildBasisFields` (highway spine,
shore tangent, …; the extension point for new field kinds). `streets/trace.ts` —
**streamline tracing** through that field with a `RoadIndex` spatial hash
enforcing separation; layers differ only in `TraceOpts` (`MAJOR`,
`MINOR`). `streets/graph.ts` — polylines become a **planar graph**; its
faces are the districts (major graph) and blocks (full graph). Road width
follows road class (highway 32 m, arterial 18, street 9, ramp 8).
`streets/smooth.ts` fillets sharp bends of traced roads; `streets/join.ts` curves a
tracer's dead end into the arterial ahead instead of pruning it.

Each arcology adds a `radialBasis` field (spokes and rings
around its centre), and landmark footprints are `TraceOpts.obstacles`
the tracer never enters.

`streets/irregularity.ts` — low-frequency noise field sampled by zoning
and patch sizing so planned-grid quarters flow into organic ones spatially.

### The lot pass (`src/gen/lots/`)

Design: `docs/specs/2026-10-15-buildings-design.md`. One module per
concern: `setback.ts` (per-side setback, buildable piece, road
clearance), `fabrics.ts` (fabric choice per block), `strips.ts` (lot
strips along the frontage), `fitbox.ts` (fit box per lot, acceptance
gate), `shapes.ts` (shape catalogue), `composites.ts` (E1–E6),
`layout.ts` (lots and buildings per fabric), `landmarks.ts` (arcology,
megablock, compound lots), `index.ts` (orchestration, seeded streams).

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
- **Smoothing order**: a road is smoothed before anything ends on it, never
  after (`finalize` does not simplify).
- **Window containment**: every generated point lies inside
  `[0, sizeM]²`. Tracing stops at the window edge and faces are bounded
  by `windowRing` (the river course deliberately carries ±500 m
  off-window margin).
- **Streamlines never enter water** except from a crossing seed
  (`riverCrossingSeeds`); everything else stops at the shore.
- **Every block carries `districtId`** by centroid containment (nearest
  district fallback); ids are identifiers, never array indices.
- **Polyline degeneracy**: the bridges/clipping pipeline must treat a
  2-point road identically to the pre-polyline code (`pointAtT` on 2
  points is plain lerp) — the old tests pin this.
- **Deliberate exception**: frontage roads are indexed only at the street
  stage (never during arterial passes), so arterials cross the highway.
- **GENERATOR_VERSION** (`src/gen/types.ts`) bumps whenever same-seed
  output changes; existing shared URLs re-render differently.
- **Toy before wiring**: field/tracer changes are validated visually in
  `tools/streets-toy/` before touching `src/gen/sector/`.
- **uicheck is part of development** (`tools/uicheck/run.sh`): UI
  changes extend it in the same task; look at the screenshots, don't
  trust exit codes.

## Deliberate ceilings

Marked with greppable `ponytail:` comments at the site — the ledger of
known shortcuts (river corridor constant width, islet moat overlaps,
label-width estimates, silent lot drops, …). One structural one:
all polygon clipping goes through `src/gen/clip.ts` (clipper2-js on a 1 mm grid;
it never throws, but its output rings need the adapter's cleanup).
Deliberate exception: clipper2-js is pinned at exactly 1.2.4 and `clip.ts`
patches its internal `getIntersectPoint` (it returned input vertices by
reference); re-check the patch on any upgrade.

## Tunables (where knobs live)

| Knob | File |
|------|------|
| Zone → irregularity bias | `sector/zoning.ts` `ZONE_IRREGULARITY` |
| Fabric weights / min fit / coherence | `lots/fabrics.ts` `FABRIC_WEIGHTS`, `MIN_FIT`, `COHERENCE` |
| Strip depth / frontage / gap | `lots/strips.ts` `STRIP_PARAMS` |
| Shape catalogue | `lots/shapes.ts` `SHAPES` |
| Setbacks per edge class | `lots/setback.ts` `SETBACK` |
| Vacant-lot chances | `lots/layout.ts` `VACANT` |
| Street spacing / step / decay | `streets/trace.ts` `MAJOR`, `MINOR` |
| Patch size / basis fields | `streets/field.ts` |
| Irregularity field size / contrast | `streets/irregularity.ts` |
| Road widths | `streets/trace.ts` (`traceLayer`), `streets/highway.ts` |
| Islet size/moat | `terrain/field.ts` `ISLET_*` |
| Tag → param values | `app/tags.ts` `TAG_EFFECTS` |

## Repo conventions

Specs `docs/specs/YYYY-MM-DD-*.md`, plans `docs/plans/`; deferred work
lives in `docs/ROADMAP.md` (authoritative). `temp/` is gitignored
scratch. Dev-only pages under `tools/` are served by `vite dev` but
never bundled.
