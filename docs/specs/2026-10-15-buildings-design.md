# Buildings: Lots, Shapes, Grounds, Landmarks — Design

Status: draft for review (sheet approved 2026-10-15). A1–A3 are universal (controller: a rectangle is the default everywhere; the zone/density factors of R23 would otherwise make notched fronts dominate dense commerce). Branch: `spec/buildings` (off `main` 5768aab).
Inputs: `docs/specs/2026-10-15-buildings-sheet.html` (catalogue ids A1–F23), `temp/buildings/investigation.md`.

## 1. Goal and scope

Buildings should read like a built city: footprints parallel to their street, closed street fronts where the
fabric has them, houses and villas in many shapes, towers that are towers, open ground that is visibly parking,
plaza, yard or green, and arcologies and landmarks that own their ground.

User rulings: "weird jagged edges which makes no sense for buildings" → none; rounded corners rare; round towers
exist; "only rarely do you have actual triangle houses. if at all they should be merged with the houses sitting
next to them. and if they are triangle then only if the house is actually bigger"; terraces and closed street
fronts; houses in more shapes and sizes, villas diverse; "tower like outcroppings and generally weirder shapes
... doesn't mean they look totally random" → composites from a fixed part list; arcology grounds "always
round-ish, some should just be big plots" and "one district be the arcology with buildings inside"; never two
identical arcologies on a map; parking lots and open spaces drawn. The user judges visually; every rule below is
a distance, angle, chance or weight.

Two phases, each its own plan, branch merge and review:

- **Phase A, lots and shapes** (§3): setback per side, lot strips, fit boxes, fabrics B1–B10 plus the existing
  styles, shapes A1–A23, composites E1–E6, fillers D1–D4, megablock hive inside the core, compound shapes
  fitted. No second clipping of a building, ever. `GENERATOR_VERSION` 9 → 10.
- **Phase B, grounds and landmarks** (§4): arcology grounds C1–C3, landmarks F1–F23 (station and rail yard are
  not in the catalogue; they belong to the transit round), flavour-pack names. Keeps version 10 if phase A has
  not been deployed when B merges, else 11.

## 2. Today's mechanisms (investigation, seeds A=42, B=782008753, C=426750495, D=2268324149)

1. **Second cut on corridors**: `corridorRects(road, w/2 + 6)` (generate.ts:454-459) and `subtractNoBuild`
   (lots.ts:204) cut every lot again, 4.5 m (street) / 9 m (arterial) deeper than the 6 m inset, as a staircase
   on curves: 72–75 % of all slanted edges.
2. **One rotated frame per block** (lots.ts:567, BSP 602) on 54–63 % non-rectilinear blocks: non-rectilinear
   footprints A 35.8 %, B 31.0 %, C 45.1 %, D 26.8 %; concave 17.7–25.3 %.
3. **No shape acceptance** (area ≥ 40 m² only, lots.ts:666): < 60 m² A 212, B 409, C 45, D 338; < 4 m wide 77 /
   190 / 19 / 147; triangles 49 / 127 / 37 / 72; up to 95 vertices.
4. **Notches** (10/35/50 %, lots.ts:285) and the 18–26 m **courtyard band** cut concave L/U/crescent pieces.
5. **Arcology plaza = no-build octagon** 16–27° off the lot grid: facets slice lots (A 5, B 11 incl. 2
   triangles); A's band has 1.29× the sector density.
6. **Megablock hive = whole face inset 6 m**: B has 34 of 79 cells outside the core (up to 70 m), spikes.
7. **Plaza/sheds** keep 1–2 BSP cells (median 6,100 m²), 181 of 418 B plaza blocks empty; **random fill** drops
   28 % of rows cells; **mitered insets** without a limit (lots.ts:157).

## 3. Phase A rules

### 3.1 Setback per block side

- R1. The block footprint is simplified at 2 m (`simplifyFace`) before anything else.
- R2. Each footprint edge gets one setback by what bounds it (edge midpoint within 2 m; several → the largest):
  street incl. frontage roads (9 m) 7.5 = 4.5 + 3 m sidewalk; ramp (8 m) 7.0; arterial and K ring (18 m) 12.0;
  sunken highway (32 m) 19.0; ground or elevated highway 26.0 = `STRIP_HALF` (spec choice: keeps today's
  shoulder, which `isStripBlock` relies on); water 5.0; window edge 0; landmark ground (plaza, arcology ground,
  megablock core) 6.0; anything else 7.5 (spec choice, as a street).
- R3. Buildable polygon: each edge line is offset inward by its setback; consecutive offset lines meet at their
  intersection, except at a reflex vertex, a vertex turning < 10°, or an intersection farther than 2 × the
  larger setback from the vertex: there both lines end on the vertex's angle bisector and are joined (two
  points). Self-overlaps go by a positive-fill union; pieces < 200 m² drop; each piece is lotted on its own.
  This replaces `insetRing`, `insetByClipping`, `corridorRects`, `subtractNoBuild` and the `noBuildStrips` input
  of `fillLots`; nothing is clipped afterwards.
- R4. A **side** is a maximal chain of buildable edges turning < 25° between consecutive edges and bounded by
  one road class; its **chord** joins its ends.

### 3.2 Lot strips

- R5. Frontage fabrics lay a strip of depth D (drawn per block, §3.4) behind every side, between the side and
  its inward offset at D; sides go in descending chord length, each strip trimmed by those already laid.
- R6. Strips are cut into lots perpendicular to the local edge (at a vertex: the bisector of the two normals) at
  frontage widths drawn per lot; gapped fabrics leave a drawn gap between lots as a filler lot.
- R7. **Corner lot**: at a convex corner with interior angle θ < 155°, the inner point is where the two offsets
  at D meet; its projections on both sides end the adjacent strips; the quad (corner, projection 1,
  inner point, projection 2) is the corner lot. At θ ≥ 155° (only where the road class changes) the strips just abut.
- R8. Whole-block fabrics use each buildable piece as one lot, chord = its longest side's chord.
- R9. Buildable area not covered by lots (the block interior) is one filler lot per piece.

### 3.3 Fit box and merge

- R10. **Fit box**: in the chord frame (x along, y inward), the largest-area rectangle inside the lot over a 1 m
  grid of x0 < x1, front edge on the innermost frontage point of [x0, x1], deepest that fits; ties → wider.
- R11. Every building is a catalogue shape fitted **into** its fit box (§3.6); a lot is never clipped.
- R12. **Merge**: a lot whose fit box holds no 6 × 8 m rectangle (either orientation) merges into the next lot
  on its side (the previous for the last); the union's fit box is recomputed. One merge per lot; a lot that
  still fits no shape becomes a filler lot (§3.8).

### 3.4 Fabrics (BlockStyle values) and layout parameters

| style | sheet | lot layout | D / size (m) | frontage (m) | gap (m) | shapes allowed |
|---|---|---|---|---|---|---|
| `perimeter` | B1 | strips, continuous | D 14–20 | 10–18 | 0 | A1–A3, A20; corner A4/A15/A16 |
| `terrace` | B2 | strips on 1–2 sides (R13), continuous | D 10–12 | 6–8 | 0 | A1 |
| `shophouse` | B8 | strips, continuous | D 20–30 | 6–8 | 0 | A1, A3; corner A15/A16 |
| `rows` | (today) | strips, gapped | D 15–30 (spec choice) | 12–30 | 2–6 | A1–A8, A10, A17, A20, A23 |
| `zeilen` | B3 | whole block, slabs (R14) | slab 12 × 40–80 | — | spacing 25–35 | A3 |
| `detached` | B4 | strips, gapped | lot depth 25–35 | 20–30 | 0 | A1, A2, A4, A20 |
| `villas` | B10 | strips, gapped | lot depth 30–40 | 25–45 | 0 | A1, A2, A4, A5, A6, A7, A10, A20 |
| `tower-park` | B5 | whole block, 1–3 towers | tower 24–36 | — | ≥ 20 apart | A2, A11, A12, A13, A14 |
| `podium` | B6, A19 | whole block | podium = fit box × 0.9; 1–3 towers 20–30 | — | — | A19 (towers A11/A12/A13 as details) |
| `bigbox` | B7 | whole block | hall = fit box × 0.5–0.7 at the rear | — | — | A1–A3, A18 |
| `sheds` | B7 | whole block, 1–3 halls in a row along the longest side | hall 30–80 per side | — | 8–20 | A1–A3, A18 |
| `plaza` | D2 | whole block, 0–2 buildings | building ≤ 0.4 × fit box per side | — | — | A11, A12, A14, A17, A21, A22, A23 |
| `garage` | F14 | whole block | 60 × 40, ramp spiral 20 / 8 as details | — | — | F14 |
| `strip` | (today) | strips along the frontage road, gapped | D 10–14 | 10–16 (spec choice) | 2–4 | A1, A20 |
| `megablock` | B9 | core hive + perimeter ring (R16) | hive BSP minCell 30, gap 2 | — | — | `hive` |
| `compound` | (today) | frontage grid inside the fence (R17) | lots 30–60 × ≤ 60 | — | 10 | A2, A3, A6, A9, A11 |

- R13. `terrace` builds on the longest side and on a side within 25° of antiparallel to it with chord ≥ 40 m;
  the rest is green (gardens).
- R14. `zeilen`: slab axis = longest side angle + twist 0–15°; centrelines 25–35 m apart; each slab the longest
  12 m-deep rectangle on its line inside the piece, capped at 80 m, dropped under 40 m.
- R15. `tower-park`/`plaza` buildings: up to 40 random tries each in the fit box, ≥ 20 m apart. `bigbox`: rear =
  fit box side away from the longest side; the front band is a parking lot, the rest yard.
- R16. **Megablock** core: a regular octagon of today's radius (`megaRadii`, 150–250 m), one edge on the block's
  longest-side angle, or (50/50, spec choice) the block-aligned rectangle of equal area; scaled down in 0.05
  steps until inside the piece inset by 26 m (6 m edge + 20 m perimeter depth); below 0.6 the core is the fit
  box of that inset. Hive: today's BSP (minCell 30, gap 2, jitter 0.3) in the core frame, cells intersected with
  the core only; a cell < 60 m² or not holding 6 × 8 m becomes plaza; alleys = the 3 longest cuts clipped to the
  core. The ring between the piece and core + 6 m is lotted `perimeter` from both boundaries. `Megablock.core`
  and `.footprint` both become this core.
- R17. **Compound**: fence and gate unchanged. Inside `insetOrLargest(footprint, 14)`, lots of frontage 30–60 m,
  depth min(60, fit depth), 10 m gaps along its longest side; the first 2–4 lots holding 20 × 20 m take a shape,
  the rest yard. Fewer than 2 → normal block, as today.

### 3.5 Fabric choice

- R18. **Sheet zone** of a block, from its district's `ZoneType` and its density class (today's `d = clamp01(0.6
  density + 0.6 neighbourhood − 0.1)`; sparse d < 0.35, dense 0.35 ≤ d < 0.65, packed ≥ 0.65, spec choice):
  `residential` → residential; `slum` sparse → fringe, dense/packed → mixed; `entertainment` sparse → mixed,
  dense/packed → commerce; `corp` → corp; `industrial` and `docks` → industrial. "centre" (landmarks only) =
  block centroid within 0.15 × sector size of the sector centre; "any" = every zone.
- R19. Weights (each row sums to 100):

  | sheet zone (density) | weights |
  |---|---|
  | residential sparse | detached 50, villas 20, rows 30 |
  | residential dense | perimeter 30, terrace 25, rows 25, zeilen 15, tower-park 5 |
  | residential packed | perimeter 50, terrace 20, zeilen 15, tower-park 10, podium 5 |
  | mixed sparse | rows 50, detached 30, shophouse 20 |
  | mixed dense / packed | perimeter 40, shophouse 25, rows 20, podium 15 |
  | commerce | perimeter 30, shophouse 20, podium 25, plaza 10, garage 5, bigbox 10 |
  | corp | podium 40, tower-park 30, perimeter 20, plaza 10 |
  | industrial | bigbox 50, sheds 35, rows 15 |
  | fringe | detached 40, villas 15, sheds 25, rows 20 |

- R20. **Coherence**: on a 500 m lattice each cell has a value `hash(seed, 'fabric', i, j)` in [0, 1)
  (unsmoothed). A block's draw u is its cell's value with probability 0.6, else a fresh `'fabric'` rng draw; u
  picks by cumulative weight in row order (spec choice: a mixture of two draws from the same weights keeps the
  shares exact while blocks in one cell agree ≥ 60 % of the time).
- R21. Forced first: ring-access arcology plaza block → `plaza` without buildings; megablock; compound pick;
  `isStripBlock` → `strip`. A whole-block fabric whose minimum fit box (zeilen 40 × 24, tower-park 50 × 50,
  podium 40 × 40, bigbox 50 × 40, sheds 40 × 30, plaza 20 × 20, garage 66 × 46) does not fit falls to the next
  lower weight of its row that fits, finally `rows`. `courtyard` retires (`perimeter` replaces it).
- R22. A non-ring arcology plaza is cut out of its face before R1; its edges are landmark ground edges.

### 3.6 Shape catalogue

Template = polygon built in a w × d box (w along the chord, d inward), parameters in metres. Aspect = d / w.
Rarity weights: common 1, uncommon 0.35, rare 0.08.

| id | shape | template rule | aspect | min w × d | zones | density | rarity |
|---|---|---|---|---|---|---|---|
| A1 | rectangle | full box | 0.5–2.0 | 6 × 10 | any | any | common |
| A2 | square | full box | 0.85–1.15 | 10 × 10 | any | any | common |
| A3 | long slab | full box | 0.15–0.4 | 30 × 10 | residential, mixed, commerce, corp, industrial | dense, packed | uncommon |
| A4 | L | arms clamp(0.35 min(w,d), 8, 16), open corner at the rear | 0.7–1.4 | 20 × 20 | residential, mixed, commerce | dense | common |
| A5 | U | legs clamp(0.3 w, 8, 14), base clamp(0.35 d, 8, 14), open to the rear | 0.6–1.2 | 26 × 22 | residential, mixed, corp | dense | common |
| A6 | T | front bar depth clamp(0.3 d, 10, 16), centred stem clamp(0.3 w, 8, 16) | 0.6–1.2 | 24 × 20 | commerce, corp | dense | uncommon |
| A7 | H | legs clamp(0.25 w, 8, 14), centred bridge clamp(0.3 d, 8, 14) | 0.6–1.2 | 30 × 24 | residential, commerce | dense | uncommon |
| A8 | comb / E | front spine clamp(0.25 d, 8, 14), 3 wings clamp(0.18 w, 8, 12) at ends and centre | 0.4–0.8 | 40 × 20 | residential, mixed | dense | uncommon |
| A9 | courtyard ring | wall clamp(0.25 min(w,d), 8, 14), hole ≥ 10 × 10 as `details` outline | 0.6–1.2 | 36 × 36 | mixed, commerce | dense, packed | common |
| A10 | open courtyard C | A9 with the rear wall removed | 0.7–1.2 | 30 × 28 | residential, mixed | dense | uncommon |
| A11 | point tower | square, 45° chamfers clamp(0.2 side, 3, 6) | 0.85–1.15 | 18 × 18 | corp, commerce | dense, packed | common |
| A12 | round tower | circle Ø min(w, d) | 1 | 16 × 16 | corp, commerce | packed | rare |
| A13 | oval tower | ellipse | 0.55–0.75 | 24 × 16 | corp | packed | rare |
| A14 | cross / plus | arms clamp(0.33 min(w,d), 10, 16) | 0.85–1.15 | 30 × 30 | corp, commerce | dense, packed | rare |
| A15 | trapezoid corner | the corner lot quad (R26) | — | area 150 m² | mixed, commerce | dense, packed | uncommon |
| A16 | triangle (flatiron) | R26 | — | area 1500 m² | commerce, corp, mixed | packed | rare |
| A17 | rounded rectangle | corners r = min(6, 0.2 min(w,d)) | 0.5–1.0 | 24 × 18 | commerce, mixed | dense, packed | rare |
| A18 | sawtooth shed | full box; teeth every 8 m parallel to the short side as `details` | 0.4–2.5 | 24 × 24 | industrial | sparse, dense | common |
| A19 | tower on podium | podium full box; 1–3 towers as `details` | 0.5–2.0 | 40 × 40 | commerce, corp | packed | uncommon |
| A20 | notched rectangle | square notch clamp(0.25 min(w,d), 6, 10) at a rear corner | 0.6–1.6 | 18 × 18 | residential, mixed, commerce | dense | common |
| A21 | D-shape | semicircle r = d / 2 on one short end | 0.45–0.75 | 30 × 18 | corp, commerce | dense, packed | rare |
| A22 | stadium | semicircles on both short ends | 0.25–0.45 | 50 × 18 | corp | packed | rare |
| A23 | big-radius rounded rect | corners r = clamp(0.25 min(w,d), 6, 10) | 0.6–0.9 | 30 × 24 | commerce, corp | dense, packed | rare |

- R23. **Choice**: among the fabric's shapes (§3.4) whose min size fits, weight = rarity × zone factor (1 if the
  sheet zone is listed, else 0.15) × density factor (1 if listed, else 0.3) (spec choice: unlisted pairs stay
  possible but rare, so no fabric runs out of shapes); mirrored with chance 0.5.
- R24. **Sizing** (sizes snap to 1 m, feature parameters to 2 m): continuous fabrics take width = fit width
  (party walls touch), depth = 0.9–1.0 × fit depth, front-aligned, aspect ranges not applied. `detached` sides
  10–16 m, `villas` 14–22 m, both offset randomly sideways and 0–6 m back. Other gapped fabrics: width in
  [max(min w, 0.5 fit w), max(min w, 0.85 fit w)], front-aligned. Depth = width × aspect drawn in range, clamped
  to [min d, fit depth]; a clamp outside the aspect range redraws the shape (3 tries, then A1 at 0.85 × fit
  box).
- R25. Circles are polygonised at 24 segments, arcs proportionally (semicircle 12, quarter 6). A11, A12, A13,
  A15, A16, A17, A21, A22, A23, composites with a bay, `hive` cells cut by an octagon edge and F buildings are
  the **curved or slanted set** for the tests.
- R26. **Corner rule** (corner lots of R7, every fabric, overriding the §3.4 lists): 80° ≤ θ ≤ 100° →
  `perimeter` fills the lot with A4 (arms D), others fit normally; 50° ≤ θ < 80° or 100° < θ < 155° → A15 = the
  corner quad itself (continuous fabrics) or a normal fit (gapped); θ < 50° → A16 if the lot area ≥ 1500 m²
  (corner blunted by a 4 m cut perpendicular to the bisector, legs L = min(70 m, leg length)), else a plaza
  filler. No other footprint has 3 vertices.

### 3.7 Composites

- R27. Chance per lot to make the building a composite: `villas` 0.5, `detached` 0.3, blocks in sheet zone corp
  or commerce 0.25, industrial 0.3, all others 0.1 (first match in this order). The composite is drawn by rarity
  among the E entries whose zone list holds the block's sheet zone and whose body, shrunk by the parts'
  overhang, still fits; none → no composite. Continuous fabrics only take E3 and E5 (inside parts only).

  | id | body | parts (on a 2 m grid, every part ≥ 6 m, all inside the fit box) | zones / density | rarity |
  |---|---|---|---|---|
  | E1 | A1 or A2, ≤ 16 m | 1 corner tower 6–14 m square at a front corner, half outside the body | residential, fringe / sparse | uncommon |
  | E2 | A4 | 1 garage annex 6–8 × 6–10 flush on a side | residential, fringe / sparse | uncommon |
  | E3 | A3 | 2 roof towers 6–14 m square inside the body | corp, commerce / dense, packed | uncommon |
  | E4 | A1, A2 or A20 | 1 semicircular bay, Ø 0.3–0.5 × front width, ≤ 16 m, on the front | corp, commerce / dense, packed | uncommon |
  | E5 | A2 | 2 stepped squares 0.8 and 0.6 of the side, offset to one corner, inside | corp / packed | rare |
  | E6 | A1, A3 or A18 hall | 1 head building 16–20 × 12–16 flush on a short side | industrial / sparse, dense | common |

- R28. A part inside the body is an inner outline (`details`); a part outside is unioned into the footprint
  (rectilinear union of axis-aligned rectangles; the bay arc stays an arc).

### 3.8 Fillers

- R29. Fillers: `parking` (bigbox apron, `garage`, commerce/industrial leftovers), `plaza` (corp/commerce
  leftovers, corner fillers, `plaza`, `podium` margin, hive leftovers), `green` (block interiors, gaps and
  gardens in sheet zones residential and fringe, `terrace`, `zeilen`, `detached`, `villas`, residential
  `tower-park`), `yard` (everything else), `pool` (villas, chance 0.4 per lot, 4–6 × 8–12 m, ≥ 3 m from house
  and lot edge; the only lot allowed inside another).
- R30. A lot's `kind` is `building` when its open ground is < 15 % of its area, else its filler kind.

### 3.9 Model changes (types.ts)

```ts
export const GENERATOR_VERSION = 10
export type BlockStyle = 'perimeter' | 'terrace' | 'shophouse' | 'rows' | 'zeilen' | 'detached' | 'villas'
  | 'tower-park' | 'podium' | 'bigbox' | 'sheds' | 'plaza' | 'garage' | 'strip' | 'megablock' | 'compound'
  | 'blockfill' // user review: dense cores as one built mass split by party walls ('B1', 'B1T' with towers)
export type LotKind = 'building' | 'parking' | 'plaza' | 'yard' | 'green' | 'pool'
export interface Lot { id: string; blockId: string; poly: Pt[]; kind: LotKind; buildingIds: string[] } // id 'LOT00001'
// Building gains: shape: string ('A1'..'A23' | 'E1'..'E6' | 'hive' | 'F1'..'F23'), lotId: string, details?: Pt[][]
// SectorModel gains: lots: Lot[]
// shared with phase B (lots.ts):
export interface FitBox { origin: Pt; angle: number; w: number; d: number }
buildable(footprint: Pt[], setbacks: number[]): Pt[][]
frontageLots(piece: Pt[], fabric: BlockStyle, rng: Rng): Pt[][]
fitBox(lot: Pt[], chord: [Pt, Pt]): FitBox
fitShape(id: string, box: FitBox, rng: Rng): { footprint: Pt[]; details: Pt[][] }
```

New rng streams `'fabric'`, `'lots'`, `'shapes'`, `'composites'`; `'buildings'` and `'notches'` retire.
`Block.alleys` is filled for megablocks only. Footprints are counter-clockwise, no repeated closing vertex,
collinear vertices removed except arc points.

### 3.10 Rendering (svg.ts, themes)

- R31. Lot layer after the district fills, before compounds and buildings: one `<path data-lots="<kind>"
  data-count=N>` per kind except `building`, both modes, fill `theme.lot[kind]`; above it, parking lots grouped
  by chord angle rounded to 5° get one path per group filled with that angle's `<pattern>` (0.3 m lines every
  2.5 m, `theme.lot.stripe`).
- R32. Details layer right after the buildings: one `<path data-details>`, fill none, `theme.building.stroke`,
  width 0.5, `vector-effect="non-scaling-stroke"`.
- R33. All five themes gain `lot: { parking, plaza, yard, green, pool, stripe }`; green is a distinct green tint
  in each, print included.
- R34. Building batching is unchanged (per district interactive, per building static); hive/strip stay put.

### 3.11 As built (phase A)

Decisions the plan pinned where the spec was open:
- Setback lookup: an edge's class comes from its midpoint (roads within 2 m via `RoadIndex`, highway by `levelAt`/`nearestT`, water 3 m outward, window, landmark ground); several: the largest; none: 7.5 m.
- Positive-fill union: `clip.ts` `unionPositive(ring)` (FillRule.Positive, no reorientation); `buildable` makes the ring counter-clockwise first.
- Sides of a piece: each buildable edge takes the setback of the footprint edge whose offset line holds its midpoint (+-0.05 m); chains break at turns >= 25 degrees and at setback changes.
- Strip cutting: widths drawn along the arc length; a rest >= the minimum width is the last lot, a smaller rest widens the previous one; single-edge lots of an untrimmed strip are quads, the rest go through `clip.intersection`.
- Fit box search: chord-frame cross-section sampled at every 1 m and at every vertex x; O(G*V + G^2); lots wider than 120 m use a 2 m grid, then refine.
- Acceptance gate in `index.ts`: drops any non-arc building with an edge < 3 m, T5 width < 6 m or area < 60 m2; its lot becomes its filler kind.
- Fabric order: cumulative draw in the R19 row order; R21 fallback by descending weight, then `rows`.
- Arcs polygonised per R25 (24 per circle, 12 per semicircle, 6 per quarter; ellipse 24).
- Whole-block lots: each buildable piece is one lot; `bigbox` splits into `parking` (front) and `yard` (hall).
- Strip fabric only on sides with setback 7.5 m; the rest of the piece is one `yard`.
- Megablock: hive BSP fills the whole buildable piece (user ruling below); cells failing the gate become `plaza`; `Megablock.core` and `.footprint` are the buildable.
- Garage (F14): 60 x 40 front-aligned, details circles O 20 and O 4, lot `parking`.
- Parking stripes: angle = longest lot edge rounded to 5 degrees.
- `Block.alleys` filled for megablocks only; the generic alley path in `svg.ts` is gone.
- Kept from `lots.ts`: `SIDEWALK`, `insetRing`, `insetByClipping`, `insetOrLargest`, `longestEdgeAngle`, `clipSegmentToRing`, `isStripBlock`, `isLandmarkBlock`.

User rulings made during implementation (2026-10-15):
- Podiums hatched and towers solid in the building fill (V3).
- Fabric weights lowered for podium and perimeter (freed weight to rows/terrace/shophouse).
- Podium template 0.45-0.65 of the fit box capped at 90 m, with 1-3 towers of 20-30 m placed anywhere.
- Megablock: the hive fills the whole block again (the old chaotic look).
- Coherence 0.6 -> 0.4.
- Rear rings of buildings in dense interiors (4 m lane).
- New `blockfill` fabric (party-wall mass with lightwells, B1/B1T).
- Vacant lots and no identical neighbours (0.15/0.05/0.02).
- Tower-park count = clamp(round(fit area / 3000), 2, 8), towers 12 m apart.
- Arcologies without a ring road keep a built ring only 8 %; otherwise open grounds (`plaza` lot).
- Highway strips 14-30 m deep, 15-60 m wide, skewed wide; deep strip blocks may draw sheds/bigbox; no hall > 120 m (bigbox over a 171 m fit box takes sheds); strip blocks never empty.
- Plaza blocks hold 1-2 pavilions, never 0.
- Sparse-block guard: a block >= 0.5 ha under 10 % built is re-laid with sheds/rows.
- R22 plaza outset fallback 6 -> 4 -> 2 -> 0 m on tight pieces.
- T8 road-clearance tolerance: setback - 2 m simplification budget.
- T7 cross-block overlap excusal (FACE_LAP ratchet) for overlapping block faces.
- Perf is not a gate while the passes keep changing ("i expect the performance to drop if we do the other passes").
- D0 clipper2-js fix: `getIntersectPoint` returned input vertices by reference; `clip.ts` wraps it with a copy.

Measurement (vite-node, dev container, timings unreliable under load; before = main 5768aab, after = this branch; non-rectilinear excludes arc/slanted catalogue shapes after, > 8-vertex footprints before):

| seed | buildings before / after | cover % | non-rect % | < 60 m2 | min width < 6 m | triangles non-A16 | hive cells outside core | gate rejections |
|---|---|---|---|---|---|---|---|---|
| P1 (app tags) | 4780 / 10368 | 34.8 / 30.2 | 49.1 / 0.0 | 213 / 0 | 1094 / 0 | 45 / 0 | 0 / 0 | n/a / 37 |
| S42 | 3394 / 10042 | 32.0 / 28.5 | 53.8 / 0.0 | 173 / 0 | 956 / 0 | 45 / 0 | 0 / 0 | n/a / 75 |
| S782 | 13858 / 40242 | 34.6 / 30.5 | 43.4 / 0.0 | 409 / 0 | 2883 / 0 | 116 / 0 | 0 / 0 | n/a / 306 |
| S426 | 1840 / 4310 | 35.0 / 32.3 | 55.4 / 0.0 | 45 / 0 | 394 / 0 | 34 / 0 | 0 / 0 | n/a / 37 |
| S2268 | 8054 / 15017 | 39.3 / 32.6 | 37.3 / 0.0 | 338 / 0 | 1461 / 0 | 64 / 0 | 0 / 0 | n/a / 156 |

Gate rejections are not 0: the gate catches mostly E4 (rows) and A1 outputs, so those templates still emit buildings that fail T4-T6 and the lot falls back to its filler. Left for a template fix.

Known:
- Browser and node models differ by about 1 % for the same params (ROADMAP).
- S782 blocks B8227 and B8232 lie over water and stay empty (ROADMAP).
- The compound scene reads weakly until phase B grounds it.

## 4. Phase B rules

### 4.1 Arcology grounds (C1–C3)

- R35. Each arcology draws a ground type first, stream `('landmarks', 'ground')`: `round` 40, `square` 35,
  `district` 25; a `(design, ground)` pair already in the sector walks on round → square → district → round.
  Access follows from the ground (R36–R38); the `(design, access)` walk applies to `round` only. `Arcology`
  gains `ground: 'round' | 'square' | 'district'`; `plaza` becomes the ground polygon.
- R36. `round` (C1): today's access draw, ring shape circle or octagon, plaza octagon r + 40, cut per R22.
- R37. `square` (C2): access `ring`, ring shape `square` with 30 m corner radius (spec choice, was 0.3 r);
  ground = square of half side r + 40 on the field angle; the design footprint shifted min(0.25 r, 30 m) along
  the ground's x axis (side drawn); 1–2 annexes (A3 or A11 by rarity) in the far band, ≥ 10 m from the tower's
  bounding circle, ≥ 6 m inside the ground edge; rest plaza.
- R38. `district` (C3): access `embedded`. Between `toBlocks` and `markWetSpans` the arcology claims every block
  with centroid within r + 200 m in the arterial/highway/water face holding the centre; ground = union of their
  footprints (largest ring, no holes). Streets ≥ 50 % inside are removed; crossing streets are cut at the edge,
  outside pieces < 30 m dropped. Contents: design footprint at the centre; 3–6 annexes (A3, A21, A11, A22 by
  rarity, §3.6 sizes, 40 tries each, ≥ 20 m from tower and each other, ≥ 6 m inside the edge, aligned to the
  ground's longest side); plaza within r + 60, green beyond; 4 m walkways tower → annex as plaza lots cut out of
  the green.
- R39. The R22 edge is a side like any other (setback 6), so lots align to the ground without wedges; a
  whole-block fabric drawn there becomes `perimeter` (spec choice) so the ground gets a built front.

### 4.2 Landmarks (F1–F23)

- R40. Count: sector ≤ 2 km 1, ≤ 4 km 2, larger 3. Per slot a kind is drawn by rarity (common 1, uncommon 0.35,
  rare 0.08, very rare 0.02 (spec choice)) among kinds with an eligible block; each kind at most once (spec
  choice), so one stadium at most. Stream `'landmark-grounds'`; picked after `selectCompounds`.
- R41. Eligible block: in the kind's zones (residential → residential; mixed → slum, entertainment; commerce →
  entertainment; corp → corp; industrial → industrial, docks; fringe → slum, residential (spec choice); centre,
  any per R18); not arcology, megablock, compound or strip; ≥ 300 m from other landmark and arcology centres
  (spec choice); fit box (R10) holds the ground in either orientation. Nearest first to the area-weighted
  centroid of that zone's blocks.
- R42. Style `landmark`: the ground rectangle centred and aligned in the fit box, contents per the table (m),
  open ground = the filler, the rest of the block yard; elements < 60 m² are `details`. F14 is phase A's
  `garage` fabric, not drawn here.

  | id | kind | ground | buildings | details | filler | zones | rarity |
  |---|---|---|---|---|---|---|---|
  | F1 | church | 40 × 70 | nave 18 × 50 + transept 34 × 12 + apse r 9 + tower 10 × 10, one union | — | plaza forecourt 40 × 14, green | mixed, residential | uncommon |
  | F2 | cathedral | 60 × 120 | F1 scaled 1.5, two 15 × 15 front towers | — | plaza forecourt 60 × 40 | centre | rare |
  | F3 | temple | 50 × 50 | octagon 30 across | — | green | residential | uncommon |
  | F4 | mosque | 50 × 80 | hall 40 × 40 | dome Ø 20, minaret Ø 6, courtyard wall 40 × 30 | plaza | mixed | uncommon |
  | F5 | cityhall | 80 × 80 | U 70 × 50 open to the street | — | plaza | centre, commerce | rare |
  | F6 | theatre | 60 × 100 | horseshoe 40 + stage house 30 × 30 + foyer 40 × 12, one union | — | plaza 60 × 30 front | commerce | rare |
  | F7 | museum | 90 × 60 | slab 80 × 20 + two 20 × 20 end wings | trees 2 m dots | plaza | commerce, corp | rare |
  | F8 | campus | 120 × 100 | comb 90 × 50 (A8), three 20 × 20 pavilions | 4 m paths | green | mixed, residential | uncommon |
  | F9 | prison | 130 × 100 | hub 20 × 20 + five 12 × 40 radial wings | wall 120 × 90 and a second 6 m inside | yard | fringe, industrial | rare |
  | F10 | powerplant | 120 × 80 | box 60 × 40, two cooling towers Ø 35 | chimney Ø 6, fence on the ground edge | yard | industrial | rare |
  | F11 | waterworks | 100 × 80 | five tanks Ø 20, control 20 × 12 | fence | yard, two pool basins 30 × 20 | industrial | uncommon |
  | F12 | watertower | 40 × 40 | circle Ø 30 | fence | yard | industrial, fringe | uncommon |
  | F13 | tvtower | 50 × 50 | shaft Ø 9 (60 m² floor; sheet 8), annex 20 × 12 | base ring Ø 30 | plaza | any | rare |
  | F15 | mall | 130 × 130 | box 120 × 80 at the rear | — | parking 90 × 40 front, yard | commerce, fringe | uncommon |
  | F16 | stadium | 160 × 120 | stadium shape 150 × 110 | pitch 105 × 68 with centre line and circle | yard | fringe | rare |
  | F17 | arena | 110 × 110 | circle Ø 90 | inner ring Ø 50 | plaza | commerce, fringe | rare |
  | F18 | fairground | 100 × 80 | six rides Ø 10–15 | wheel Ø 50 with 8 spokes | plaza | fringe | rare |
  | F19 | cemetery | 150 × 110 | chapel 15 × 25 by the gate | wall | green, 6 m plaza lanes every 30 m | residential, fringe | uncommon |
  | F20 | fortress | 130 × 130 | keep 24 × 24 | star fort outline, five bastions, 120 across | yard star, plaza courtyard | any | very rare |
  | F21 | datafort | 100 × 80 | windowless box 70 × 50 | double fence 10 m apart, guard hut 6 × 6 | yard | corp | uncommon |
  | F22 | biodome | 100 × 100 | circle Ø 80 | inner ring Ø 50 | green | corp, fringe | rare |
  | F23 | droneport | 90 × 80 | control 30 × 20 | 4 × 3 pads 12 m (squares) | plaza | industrial, corp | uncommon |

- R43. Model: `LandmarkKind` = the 22 kinds above in table order; `interface Landmark { id; kind; name; blockId;
  districtId; center: Pt; angle: number; ground: Pt[]; details: Pt[][] }`; `SectorModel.landmarks`; `BlockStyle`
  gains `'landmark'` and `'arcology'` (C3); landmark buildings `shape: 'F<n>'`, annexes their A id.
- R44. `FlavorPack.landmarkPatterns: Record<LandmarkKind, string[]>` in `generic` and `shadowrunish`, drawn on
  `'names'` after the compound names; one POI per landmark (`type` = kind, at its main building) before the
  lottery, whose candidates exclude landmark and arcology ground blocks. Rendering: `theme.building`, details in
  the R32 layer, grounds as lots.

## 5. Tests

Reference seeds: **S42** `seed=42&tags=coastal,river,arcology` (4 km), **S782** the `seed 782008753 inland 6 km`
set in generate.test.ts, **S426** `inland,small,dense,balanced,quiet,sprawl,river`, **S2268**
`coastal,medium,packed,balanced,quiet,planned`. Ratchets are pinned at merge and only tighten; existing pins
re-pin once per phase as "buildings re-roll (v10)" with old → new in the comment. Phase A: `lots.test.ts`
units and a new `buildings.test.ts` on the four seeds.

- T1 `setback per side`: synthetic block with street, arterial, water and window edges → buildable edges at 7.5
  / 12 / 5 / 0 m (± 0.01); a reflex vertex joins on its bisector; a 175° vertex makes no spike > 2 × setback.
- T2 `fit box`: a 20 × 30 m lot with a 10° arc front gives a box within 1 m of the inscribed one.
- T3 `templates are rectilinear`: every A template outside the R25 set, fitted into 20 random boxes above its
  min size, has only 90° / 270° angles (± 1°).
- T4 `min edge`: every footprint edge ≥ 3 m, except arc edges (both end vertices turning ≤ 15.5°).
- T5 `min width`: from every edge midpoint the inward normal runs ≥ 6 m before meeting another edge.
- T6 `no small buildings`: < 60 m² = 0. T7 `no overlap`: pairwise intersection ≤ 0.5 m² (party walls touch).
- T8 `road strips › lots never overlap a road strip` (kept name): no footprint vertex closer than its R2 setback
  − 0.5 m to a road centreline.
- T9 `non-rectilinear share`: buildings outside the R25 set with an angle > 1° off 90/180/270: ≤ 2 % per seed
  (ratchet, pinned lower if measured lower).
- T10 `triangles`: every 3-vertex footprint is A16 on a corner lot with θ < 50° and lot area ≥ 1500 m².
- T11 `lots`: simple polygons inside the block's buildable (0.05 m); buildings inside their lot (0.05 m); lots
  of a block overlap ≤ 0.5 m² pairwise, except a `pool` in its green lot.
- T12 `fabric mix`: pooled over the seeds, each sheet-zone row with ≥ 20 blocks holds every fabric of weight ≥
  20 at ≥ 0.5 × its weight share (floors); measured table in the comment.
- T13 `megablock`: every hive cell inside the core (0.05 m), i.e. outside cells 0 (B was 34).
- T14 `compound`: 2–4 buildings, each ≥ 8 m inside the fence, ≤ 12 vertices unless a composite.
- T15 `deterministic`: two runs give equal `buildings` and `lots`.
- T16 svg: lot and details paths in both modes; the `data-count` tests (svg.test.ts ~405–430) count buildings as
  before plus lots per kind. T17 perf: P1 within +15 % of main (median of 3, container).
- uicheck A: eight scenes at ~300 m visible — `perimeter`, `terrace`, `zeilen`, `villas`, `podium`, `bigbox`,
  `megablock`, `compound` — on reference seeds, coordinates pinned in `check.mjs` at implementation; each
  asserts ≥ 1 `data-lots` path and the buildings path; screenshots looked at.

Phase B:

- T18 `ground types`: seeds 1–200 with the arcology tag give 40/35/25 ± 6 points; no sector repeats `(design,
  ground)`.
- T19 `district ground`: no street point inside a C3 ground farther than 1 m from its edge; C3 buildings inside
  it (0.05 m).
- T20 `ground edge`: outside a C1/C2 ground no building vertex within 5.5 m of it and no 3-vertex footprint
  within 50 m (A 5, B 11 facet cuts → 0).
- T21 `landmarks`: count per size; unique kinds; ground inside the block's buildable (0.05 m); one POI each with
  a non-empty name in both packs; never on arcology, megablock, compound or strip blocks.
- T22: `non-ring arcology blocks keep lots outside the plaza` holds for `round` grounds.
- uicheck B: `arcology-round`, `arcology-square`, `arcology-district`, `landmark` (stadium or cemetery), pinned
  as above; screenshots looked at.

## 6. Measurement

Per reference seed, before (main 5768aab) and after each phase (`temp/buildings/an*.mts`): building count, cover
%, non-rectilinear and concave share, < 60 m², min width < 6 m, 3-vertex and > 8-vertex counts, median area per
fabric, lots per kind and area share, fabric mix per sheet zone, megablock cells outside the core, P1 time
(median of 3). Expected after A: non-rectilinear ≤ 2 %, < 60 m² 0, triangles A16 only, outside-core 0. Phase B
adds per arcology the ground type, buildings in the r + 210 m band and cut by the ground edge (expected 0), and
landmarks placed per seed.

## 7. Out of scope and follow-ups

- Transit round (station, rail yard, lines; ROADMAP); parks zone (D4 green is the hook); POI rework (the
  lottery stays, only landmark POIs are added).
- Follow-ups for ROADMAP: alleys/rear lanes for fabrics other than megablock; roof details beyond podium towers
  and sawtooth; parking stripes aligned per lot without the 5° rounding; landmark variants by flavour pack (e.g.
  shrine instead of church).
