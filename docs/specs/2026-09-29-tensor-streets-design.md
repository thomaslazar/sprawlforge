# Tensor-Field Streets — Design

Status: approved in brainstorm, spec for review
Branch: `spec/tensor-streets`
Replaces: `docs/specs/2026-08-06-organic-streets-design.md` (twisted bisection)
Depends on: `docs/specs/2026-08-04-terrain-v2-design.md` (terrain, unchanged)

## 1. Goal

Replace the twisted-bisection street fabric with roads traced through a
tensor field (Chen et al. 2008, "Interactive Procedural Street Modeling";
same family as ProbableTrain's citygen). Roads come first; districts and
blocks are the cells the road graph encloses. The result must read as a
city: through-streets, crossroads, neighbourhoods that share one grid
orientation and snap at seams, roads that follow the shore, and a highway
that is elevated, sunken, or at grade depending on the district it crosses,
with real interchanges.

Scope: streets, districts, blocks, buildings, highway. No megablocks,
arcology hubs, or a second highway (see §14).

## 2. Why the current streets fail

Observed on seed 1443928265 (`planned` and `sprawl`):

- Twisted bisection is a treemap partitioner. Every cut dead-ends on its
  parent cut: T-junction soup, no through-streets, no crossroads, nothing
  continues across a district border.
- Arterials wander (midpoint displacement + Chaikin) with nothing to
  follow. Real curvature follows a coast, an older road, or a destination.
- Irregularity is a scalar noise field, so neighbouring cuts pick unrelated
  angles. Real neighbourhoods share one orientation for hundreds of metres.
- Random-angle cuts produce wedge and sliver blocks; buildings inherit them.
- Highway is a straight vertical bar at a hardcoded x, arterials glued
  across it, no ramps.
- `twisted.ts` carries an epsilon ladder, retries and a dozen `MEANDER_*`
  constants — symptoms of fighting the algorithm.

## 3. Decisions

Recorded from the brainstorm; each has a one-line reason.

1. **Orientation from seeded patches, not districts.** Districts are
   derived from roads, so the grid direction cannot come from them. The
   sector is covered by jittered-lattice patches, each with one grid angle.
2. **Irregularity drives patch size and wobble.** Planned = large patches,
   straight roads, regular spacing. Sprawl = small patches, noise rotation,
   spacing jitter, early-dying minor roads. Same `effectiveIrregularity`
   field for the whole hierarchy (existing invariant kept).
3. **Hard performance budget** (§10), with step and seed caps so the worst
   case is bounded, not just the typical one.
4. **River crossings are seeds.** Bridges are decided at trace time by
   seeding a crossing every ~1 km; arterials bridge corridors up to 450 m wide; streets stop at the bank.
5. **Highway level is per district**, sticky along the highway, one step at
   a time (sunken ↔ ground ↔ elevated). Roads pass under, over, or are
   barred depending on the level.
6. **Preview page first.** A dev-only harness (§11) is the visual gate
   before sector wiring, as with the previous spec.
7. Labels keep the area-weighted land-block centroid. `District.poly` and
   `Block.poly/footprint` keep their meaning, now sourced from graph faces.
   Render, exports, uicheck contracts stay.
8. Exactly one highway per sector, now curved.

## 4. Pipeline

New order in `src/gen/sector/generate.ts`:

| # | Stage | Module | Output |
|---|-------|--------|--------|
| 1 | Terrain | `terrain/` (unchanged) | water/land polys, `riverSlice` |
| 2 | Patches | `streets/field.ts` | orientation patches with angle + size |
| 3 | Field | `streets/field.ts` | `sample(p) → {major, minor}` unit directions |
| 4 | Highway trace | `streets/highway.ts` | one highway polyline |
| 5 | Major roads | `streets/trace.ts` | arterial polylines (~400 m apart) |
| 6 | Crossing seeds | `streets/trace.ts` | arterials seeded across the river |
| 7 | Minor roads | `streets/trace.ts` | street polylines (~100 m apart) |
| 8 | Graph | `streets/graph.ts` | planar graph, faces |
| 9 | Districts | `streets/graph.ts` | faces of the major-road graph |
| 10 | Zoning | `sector/zoning.ts` (adapted) | zone per district |
| 11 | Highway levels + interchanges | `streets/highway.ts` | segments, crossings, ramps |
| 12 | Blocks | `streets/graph.ts` | faces of the full graph, clipped to land |
| 13 | Buildings | `streets/lots.ts` | lots per block |
| 14 | Names, POIs, piers | unchanged | |
| 15 | Render | `render/svg.ts` (extended) | |

Every stage keeps its own `mulberry32(hashSeed(seed, '<stage>'))` stream.

## 5. Road field (`src/gen/streets/field.ts`)

**Patches.** Jittered lattice over the sector window plus a 500 m margin.
Base spacing is read from `effectiveIrregularity` at the lattice point:
900 m at irregularity 0.05, 400 m at 0.95, linear between. Each patch
gets one angle:

- If the patch centre is within 300 m of water, angle = local shore
  tangent (nearest water-ring edge, or the river course).
- Otherwise a seeded draw from the patch rng, biased 60 % toward the
  nearest water-adjacent patch's angle so inland grids relate to the
  coast, 40 % free.

**Basis fields.** A list, evaluated and summed per sample point:

| Basis | Direction | Weight |
|-------|-----------|--------|
| `grid` | nearest patch angle, blended with the second-nearest over a 100 m seam | 1 |
| `boundary` | tangent of the nearest water edge | 1 at the shore, 0 beyond 250 m |
| `noise` | grid rotated by low-frequency noise (period ~350 m, ±35°) | `0.5 × irregularity`, only above irregularity 0.4 |

The list is data (`BASIS_FIELDS`), so the follow-up cyberpunk layer adds
`radial` (arcology hub) and `spine` (elevated highway attractor) entries
without touching the tracer.

**Sampling.** `sample(p)` returns the blended major direction and its
perpendicular. Sign ambiguity is resolved by the tracer (it keeps the
direction closest to its previous step). Field values are cached on a
20 m grid; the tracer bilinearly interpolates. This is the only per-point
cost that scales with sector size.

## 6. Tracing (`src/gen/streets/trace.ts`)

Standard streamline tracing with a seed queue and a spatial hash.

**Parameters** (constants, not knobs):

| | major (arterial) | minor (street) |
|---|---|---|
| separation | 400 m | 100 m |
| step | 10 m | 10 m |
| max steps | 600 (6 km) | 200 (2 km) |
| width | 18 m | 9 m |
| direction | major axis | minor axis, seeded from major roads |

Sprawl modifiers (scale with irregularity above 0.4): separation jitter
±40 %, and minor streamlines get a per-step decay chance so ~20 % of
minor roads at irregularity 0.95 die early (dead ends, cul-de-sacs).

**Seeds.** Major seeds: the highway polyline (every 400 m), then the
crossing seeds (§8), then a Poisson-disc fill of the land at 400 m. Minor
seeds: every 100 m along each major road, alternating side. Seeds are
processed in queue order for determinism; the queue is capped at
`4 × (sizeM / separation)²` entries.

**Stop rules**, checked every step:

1. Leaves the sector window, or
2. Enters water (the point is inside a water ring), or
3. Comes within `snap = 0.3 × separation` of an existing road of the same
   or higher class → snap the endpoint onto that road (junction), or
4. Comes within `0.7 × separation` of a parallel road (angle < 25°) →
   stop (prevents doubled roads), or
5. Reaches max steps or the decay roll fails.

A streamline is traced in both directions from its seed and joined. A
result shorter than 60 m is discarded.

**Prune, never invent.** Geometry comes only from field tracing plus rule 3;
nothing is bent or extended to a junction. After tracing, `pruneDangling`
cuts any end that is not on the window edge, near water, or welded (6 m) to
an acceptable road (arterials: arterial/highway; streets: any) back to its
last junction, and drops a road left under its minimum length (300 m
arterial, 60 m street). Street ends from a decay stop (rule 5) may dangle.

Tracing never touches `polygon-clipping`.

## 7. Graph and faces (`src/gen/streets/graph.ts`)

1. **Snap**: endpoints within 5 m of another road's vertex or segment are
   welded to it.
2. **Split**: every segment pair intersection becomes a vertex (sweep over
   the spatial hash, not O(n²)).
3. **Faces**: half-edge walk, counter-clockwise, drop the outer face.
4. **Land clip**: faces are intersected with the land rings (this is the
   one place `polygon-clipping` remains — once per face, not per building).
5. **Sliver merge**: a face with area < 2 000 m² or a minimum width
   < 20 m is merged into the neighbour sharing its longest edge.

Two graphs are built: **major graph** (highway + arterials) → districts;
**full graph** (all classes) → blocks. Every block face lies inside exactly
one district face; the block's `districtId` is the district whose face
contains its centroid.

Each face carries `flags: Record<string, never>` today — an empty object
reserved for the follow-up (`megablock`, `hub`) so per-face data has a home
without a type change.

## 8. Water

- Streamlines stop at water (§6 rule 2). No road ever enters the sea.
- **River crossing seeds.** Along `riverSlice.course`, every ~1 000 m
  (seeded jitter ±200 m), skipping stretches where the river is wider
  than 450 m: a major seed placed mid-river, traced perpendicular to the
  course in both directions, allowed to cross the river corridor. The
  wet interval of that road is marked `bridge: true`.
- The highway gets exactly one crossing seed, at the river point nearest
  the highway's straight-line path; its wet interval is a bridge with no
  interchange.
- `bridges.ts` shrinks to: mark wet intervals on crossing roads, and the
  existing islet/sea rules (`MIN_SHORE_ANGLE`, unlandable truncation) for
  roads that touch lake or sea edges after snapping. `planBridges`,
  `splitHostAtBridges`, `joinArterialsAcrossHighway` are deleted.
- Piers, shore zoning, `SHORE_CLEAR` unchanged.

## 9. Highway (`src/gen/streets/highway.ts`)

**Trace.** One streamline through a strong directional field: the grid
basis with an added `spine` weight (2) pointing along a seeded axis
(vertical ± 20°). Entry point on one sector edge, seeded; traced across to
the opposite edge so it continues into a neighbour sector later. Width
32 m. Minimum bend radius 300 m (the tracer clamps turning per step).

**Levels.** Decided after zoning (stage 11). The highway is cut into
stretches at district borders (where it crosses a district-face edge).

| Zone | preferred level |
|------|-----------------|
| corp | sunken |
| residential, entertainment | sunken or elevated (seeded, once per sector) |
| industrial, docks, slum | elevated or ground (seeded, once per sector) |

Rules, in order:

1. Start with the first district's preference.
2. A stretch keeps the previous level unless its district prefers
   something else.
3. Level changes are one step: sunken ↔ ground ↔ elevated. If a district
   wants elevated after sunken, that district gets ground and the next
   change may go on to elevated.
4. At most 2 level changes per sector.
5. A stretch shorter than 500 m inherits the previous level.
6. A river-crossing stretch that is sunken is forced to elevated
   (counts toward the change cap; if the cap is spent, the whole sector
   is re-rolled with the cap raised by one).

**Per level:**

| Level | roads | buildings | render |
|-------|-------|-----------|--------|
| elevated | all roads pass under, no stop rule | no-build strip: width + 10 m shoulder | drawn on top of everything, column ticks every 40 m |
| sunken | all roads pass over as short decks | no strip (buildings up to the trench edge) | trench (two edge lines), roads drawn over it as short bridge decks |
| ground | minor streets stop at the corridor edge; arterials cross as bridge (over) or tunnel (under), seeded per crossing | no-build strip: width + 10 m | shoulder lines, roads over drawn as decks, roads under drawn dashed inside the corridor |

The tracer needs the level *before* stopping minor streets at a ground
stretch, but levels are decided after zoning. Resolution: minor streets
are traced ignoring the highway; after levels are fixed, minor streets
crossing a ground stretch are cut at the corridor edge (the piece inside
the corridor is removed, both remnants keep their ids with a suffix).
Blocks are computed after this cut.

**Interchanges.** Every ~1 000 m along the highway, the nearest arterial
crossing becomes an interchange (never on a bridge span, never within
200 m of a level transition). Diamond type, four ramps:

- Ramp = polyline from a point 120 m along the arterial (each side of the
  highway, each direction) to a point 200 m along the highway, curved by
  one quadratic control point so it merges at a shallow angle.
- Ramps are `Road` entries with `class: 'ramp'`, width 8 m, `name: null`.
- Elevated: ramps descend (render: drawn between highway and streets).
  Sunken: ramps descend into the trench. Ground: ramps at grade.

**Transitions.** At each level change a 150 m slope is marked on the
highway (`segments[i].transition`), rendered as a hatched band.

## 10. Performance

Budget end-to-end in the worker on a laptop:

| sector | budget |
|--------|--------|
| 4 km | ≤ 1.5 s |
| 6 km | ≤ 4 s |

One vitest test generates seed 42 at 4 km and 6 km and asserts wall time
under budget; skipped when `CI` is set (flaky on shared runners). Worst
case is bounded by the step caps, the seed-queue cap, and the 20 m field
cache. Face splitting is sweep-based over the spatial hash.

## 11. Preview harness (hard gate)

`tools/streets-toy/` replaces `tools/partition-toy/`. Dev-only page (not
in the app bundle) that, for a seed and the three street tags, draws:

1. the patches and their angles,
2. the field as a sparse direction glyph grid,
3. traced roads by class (highway, arterial, street, ramp),
4. faces (districts thick, blocks thin),

on a real terrain sample (coastal + river). Controls: seed, tag, sector
size, stage toggle. `tools/streets-toy/shot.mjs` screenshots each stage
per tag like `theme-preview`.

Sector wiring starts only after the unit tests in §12 pass and the
screenshots read as a city (through-streets, crossroads, shore-following
roads, visible orientation seams, interchanges).

## 12. Testing

Unit (`src/gen/streets/*.test.ts`):

- Determinism: same params → deep-equal roads, faces, buildings.
- Field: patch angles within 300 m of water equal the shore tangent
  ± 5°; seam blend continuous (no direction jump > 30° between adjacent
  20 m cells except at water).
- Tracer: no streamline enters water; no two roads of the same class
  closer than `0.5 × separation` along more than 100 m; every endpoint is
  on the window edge, on water, or welded to another road.
- Graph: faces tile the land within 1 % area; no face self-intersects;
  no sliver survives; every block centroid lies in exactly one district.
- Highway: exactly one; levels obey the one-step and cap rules; every
  interchange has four ramps; no interchange on a bridge or transition.
- Perf test (§10).

Existing tests for `terrain/`, `names/`, `pois`, `piers`, `zoning`
(adapted for face input), `tags`, `params` stay. `partition/*.test.ts`,
`roads.test.ts`, `buildings.test.ts` and most of `bridges.test.ts` go with
their modules.

uicheck (`tools/uicheck/check.mjs`): existing planned/sprawl screenshots
stay; add one assertion on seed 42 `planned` that the SVG contains at
least one `polyline[data-class="ramp"]` and at least 20
`circle[data-junction="4"]` markers (the renderer emits an invisible
marker per four-way junction, like the `data-id` attributes uicheck
already counts for buildings).

## 13. Data model

```ts
export type RoadClass = 'highway' | 'arterial' | 'street' | 'ramp'

export type HighwayLevel = 'elevated' | 'sunken' | 'ground'

export interface HighwaySegment {
  /** arc-length t range on the highway polyline, 0..1 */
  from: number
  to: number
  level: HighwayLevel
  districtId: string
  /** true for the 150 m slope at the start of this segment */
  transition: boolean
}

export interface HighwayCrossing {
  roadId: string
  /** arc-length t on the highway */
  at: number
  kind: 'over' | 'under'
  interchange: boolean
}

export interface Road {
  id: string
  class: RoadClass
  points: Pt[]
  width: number
  name: string | null
  bridge?: boolean
  /** highway only */
  segments?: HighwaySegment[]
  crossings?: HighwayCrossing[]
}

export interface District {
  // unchanged fields; poly is now a major-graph face ring
  flags: Record<string, never>
}

export interface Block {
  // unchanged fields; poly is now a full-graph face ring
  flags: Record<string, never>
}
```

`GENERATOR_VERSION` becomes 5. Exports (`src/app/exports.ts`) carry the
new fields through untouched; ramps export unnamed like streets.

Themes gain `road.ramp` and `highway: { trench, column, hatch }` colours;
every theme in `theme.ts` gets values (uicheck's theme pass will fail
otherwise).

## 14. Out of scope → ROADMAP

- Megablocks, arcology hubs, radial fields, elevated-highway-as-attractor
  ("cyberpunk layer" spec). Hooks left: `BASIS_FIELDS` list, face `flags`.
- Second highway, highway-to-highway junctions, cloverleafs.
- A tag to force one highway level.
- Tributaries and confluences (still deferred from terrain v2).
- Ground-level highway noise walls as geometry (render-only today).

## 15. Delivery

- Delete: `src/gen/partition/`, `src/gen/sector/roads.ts`,
  `src/gen/sector/buildings.ts`, `tools/partition-toy/`.
- Shrink: `src/gen/sector/bridges.ts`.
- Add: `src/gen/streets/{field,trace,graph,highway,lots}.ts`,
  `tools/streets-toy/`.
- Adapt: `generate.ts`, `zoning.ts` (face input), `types.ts`,
  `render/svg.ts`, `render/theme.ts`, `tools/uicheck/check.mjs`,
  `ARCHITECTURE.md` (pipeline table and "the heart" section).
- One PR from `spec/tensor-streets`; the plan
  (`docs/plans/2026-09-29-tensor-streets.md`) orders tasks so the toy
  gate (§11) lands before any sector wiring.
