# Cyberpunk Layer, Part 2: Highway Frontage and Corporate Compounds — Design

Status: spec for review
Branch: `spec/cyberpunk-part2` (off `main` 7e75bf7)
Depends on: `docs/specs/2026-10-02-cyberpunk-layer-design.md` (part 1,
merged as PR #7). Perf round follows this part.

## 1. Goal

Two more cyberpunk signatures the user asked for after part 1:

- **C. Highway frontage strips** — a service street runs along both sides
  of the highway wherever it is elevated or at ground level, and the thin
  band between street and highway is packed with narrow lots facing the
  highway, so the highway reads as a lit spine through the city.
- **D. Walled corporate compounds** — in corp districts a block becomes a
  fenced campus with one gate, a few large buildings around a court, and
  a lawn; a corp-campus POI names it.

User decision: frontage on both sides, everywhere the highway is not
sunken, regardless of zone or density.

## 2. Frontage strips

### 2.1 Frontage roads

- Built in `traceRoads` after the highway and after `placeLandmarks`, before
  the arterial passes (like ring roads): for every highway segment whose
  level is `elevated` or `ground`, two polylines offset from the highway
  centreline by `FRONTAGE_OFF = STRIP_HALF + 26` m (one per side; `STRIP_HALF`
  is the existing no-build half-width in `streets/highway.ts`), sampled
  every 10 m along the segment and simplified like other roads. The band
  left for lots is `FRONTAGE_OFF − 4.5 (half street) − 6 (sidewalk) −
  STRIP_HALF` ≈ 15.5 m deep nominal (median measured ≈ 9 m on seed 20).
- Class `street`, width 9, ids `F<n>L` / `F<n>R` per segment `n`, `name:
  null` (named by the street-name pass like any street).
- Cut where they are not wanted: wet stretches removed (`dryRuns`), parts
  inside an arcology plaza or megablock core removed (obstacle test),
  parts outside the window removed; pieces shorter than 60 m dropped.
  Nothing is built along `sunken` segments.
- Frontage roads enter the `RoadIndex` at the street stage, after the
  arterial passes: streets snap onto them and stop on them. Arterials must
  not see them, or an arterial approaching the highway would snap onto the
  frontage road and stop there instead of crossing (interchanges need
  arterials that continue across). They are returned in
  `streets`; they are not used as seeds for the street queue. They are
  exempt from `pruneDangling` inside `traceRoads` (their ends sit on the
  window, water or obstacle cuts; prefix `F`, same mechanism as `K` roads).
  After the sunken stretches are trimmed, the generate.ts street prune
  treats them as ordinary streets, so a remnant hanging at a sunken boundary
  is cut back to its last junction.
- Interchange ramps are built later and may cross a frontage road; the
  crossing renders like any ramp over a street. No cut.
- The existing infill helper `frontageOf` stays for faces along `sunken`
  stretches only (there is no frontage road there); for other faces the
  frontage road already bounds them.

### 2.2 Strip blocks

- A block is a **strip block** when its footprint centroid lies within
  `FRONTAGE_OFF + 1` m of the highway centreline and outside the highway
  no-build strip, and the block carries no landmark flag.
  `BlockStyle` gains `'strip'`.
- Lots: the block inset is the usual sidewalk inset. Lots are cut along the
  highway direction (`longestEdgeAngle` of the footprint, which is the
  highway direction for a strip block): BSP with `minCell: 10`, `gap: 1`,
  `jitter: 0.3`, rng stream `'frontage'`, cells clipped to the inset,
  pieces ≥ 40 m² kept; no alleys, no notches, no courtyard/plaza styles.
  Cells longer than 25 m along the road are split again at 25 m.
- Render: strip buildings are drawn in their own batch (`<path
  data-frontage>`) filled `theme.frontage.fill`, stroked `theme.frontage.
  stroke` 0.5 px, excluded from the generic building batch (same mechanism
  as hive cells).

## 3. Corporate compounds

### 3.1 Selection

- After blocks exist and before `fillLots`: rng stream `'compounds'`. For
  each district with zone `corp` and no `flags.arcology`, one chance draw:
  corpDominance ≥ 0.7 → 60 %, 0.3–0.7 → 30 %, < 0.3 → 10 %. On a hit, the
  largest block of that district with land area ≥ 15 000 m², no landmark
  flag and not a strip block becomes a compound. A district whose area
  exceeds 400 000 m² (40 ha) gets a second draw for a second block.
  Districts are visited in id order; both draws always happen (fixed rng
  order).
- `Compound { id: 'CMP<n>'; name: string; blockId; districtId; center: Pt;
  fence: Pt[]; gate: [Pt, Pt] }` on `SectorModel.compounds`;
  `Block.style = 'compound'`, `Block.flags.compound = id` (`LandmarkFlags`
  gains `compound`).

### 3.2 Geometry (in `fillLots`, compound branch)

- Fence = block footprint inset by 4 m (`insetRing`, `insetByClipping`
  fallback, largest piece). Gate = a 12 m gap in the fence on the fence
  edge whose midpoint is nearest to the widest road within 15 m (ties: the
  first in road order); the gap is centred on that edge's midpoint and
  stored as `gate`.
- Buildings: inner area = block footprint inset by 14 m (fence 4 m + 10 m;
  insetting the many-vertex fence again can stall polygon-clipping); BSP
  `minCell: 40`, `gap: 10`, `jitter: 0.2`, on its own rng stream
  `'compound-lots'` (so selection draws stay fixed when geometry falls
  back); cells clipped to the inner area; the 2 to 4 largest cells (each
  ≥ 400 m² and mean width 2A/P ≥ `COMPOUND_MIN_WIDTH` = 14 m, which drops
  slivers shaved by the highway strip) become `Building`s; the rest is
  lawn. The gate edge is the nearest-to-the-road fence edge among those
  ≥ 14 m long (longest edge if none).
  No alleys. The compound centre = fence centroid.
- No normal lots in a compound block.

### 3.3 Names, POIs, render

- Packs gain `compoundPatterns` (≥ 3 each, e.g. `'{corpA} Campus'`,
  `'{corpA} Research Park'`, `'{corpA}-{corpB} Compound'`) and POI type
  `corp_campus` (zones `['corp']`). `Compound.name` is drawn from the
  `'names'` stream after the landmark names (last draws). `placePois` adds
  one `corp_campus` POI per compound at its centre with the compound's
  name, `buildingId: ''`, before the lottery; the lottery may still pick
  compound buildings (they are ordinary corp buildings).
- Theme gains `frontage: { fill; stroke }` and `compound: { fence; ground }`
  in all five themes.
- Render, landmark pass: compound ground = fence polygon filled
  `compound.ground`; fence drawn as two open polylines (the fence ring at
  4 m and a parallel at 5.5 m inset), each 0.8 px `compound.fence`, both
  skipping the gate span; `data-compound="CMP1"` on the ground polygon.
  Compound buildings render in the generic building batch. Labels: the POI
  label only (no landmark label).

## 4. Model and version

`GENERATOR_VERSION` becomes 7.

## 5. Tests

- Frontage: on seed 42 coastal+river 4 km and seed 20 coastal+river 2 km:
  for every elevated/ground segment, sampling the offset line every 100 m
  on both sides, a `street` point lies within 6 m unless the sample is wet,
  inside a plaza/core or outside the window; no frontage road along sunken
  segments; frontage roads have no dangling ends (both ends on water, the
  window, a segment boundary or another road); strip blocks have ≥ 3 lots,
  all lots within the band, no alleys; no building inside the highway
  no-build strip (existing invariant).
- Compounds: counts per band on three seeds (upper bounds; ≥ 1 on a
  corp-run 4 km seed); fence inside the block; gate width 12 ± 1 m; 2–4
  buildings inside the fence, none in the gate; one `corp_campus` POI per
  compound with its name; no compound on strip or landmark blocks.
- Render: `[data-frontage]` and `[data-compound]` present; all themes have
  the new keys.
- uicheck: `?seed=42&tags=coastal,river` ≥ 1 `[data-frontage]` and a
  screenshot `frontage.png`; `?seed=42&tags=inland,corp-run` ≥ 1
  `[data-compound]` and `compound.png`; both looked at.
- Perf: within +10 % of main on seed 42 coastal+river 4 km.

## 6. Out of scope

Perf round (next). Skyways between arcologies, compound interiors beyond
the court, frontage along ramps, under-deck markets beneath elevated
stretches (possible later: lots inside the no-build strip between columns).
