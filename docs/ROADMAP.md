# SprawlForge Roadmap

## Build order

1. **Sector generator** — v1 per `docs/specs/2026-08-03-sprawlforge-design.md` ✅
2. **Terrain v2 + organic map redesign** — phases 1+2 ✅; phase 3 (organic
   streets) ✅; see below
3. **Metroplex generator** — parent of sectors, proves linkage chain.
   Candidate metroplex-scale landform: **city on an island** — a whole
   metro occupying an island, distinct from the sector-scale `islands`
   water modifier (small uninhabited islets inside a sector's water).
4. **Battlemap generator** — interiors/street combat, seeded from sector buildings
5. **Node map generator** — abstract location graphs

## Terrain v2 + organic map redesign

Phases 1+2 are specced: `docs/specs/2026-08-04-terrain-v2-design.md`
(metro-scale heightfield, one-pass water contouring, carved rivers,
bridges, waterline clipping, shore zoning, piers). Phase 3 (organic
streets) is specced and shipped: `docs/specs/2026-08-06-organic-streets-design.md`.
Additional deferrals recorded in that spec §8: tributaries/confluences,
elevation rendering, shallow-water bands, ships/harbor props.

v1 water is a toy (straight east coast, horizontal river band, coast wins
over river, no bridges, land clipped as rectangle) and the BSP street grid
reads as a treemap. One redesign, three shippable phases, one
`GENERATOR_VERSION` bump if landed as one release. Phases 1+2 and the
organic street patterns share a dependency: an arbitrary-polygon geometry
core (clipping, insetting, filling non-rectangular shapes).

1. **Terrain v2** ✅ — terrain generated first, city adapts. Coast on any
   side with a curved waterline; meandering river that can coexist with
   the coast and flow into it; waterline as first-class polyline. Biggest
   variety win, visible even with rectangular streets.
2. **City adapts to terrain** ✅ — blocks/buildings clipped to the waterline
   (waterfront buildings reach the river's edge), dock zones biased to
   the shore, roads crossing water become bridges (rendered as such,
   network stays connected).
3. **Organic street patterns** ✅ — see
   `docs/specs/2026-08-06-organic-streets-design.md`.

## Deferred (explicit v1 excludes — do not forget)

- **Structural editing** — moving walls/roads/buildings by hand. v1 is
  generate + knobs + light annotation only.
- **Elevation / terrain height** on sector maps.
- **Tributaries and confluences** — branch networks and river merges.
- **Shallow-water bands option** — rendering distinct shallow zones on water.
- **Buildable islets + causeways** — v1 `islands` water modifier islets get
  no dedicated settlement logic (an occasional small district landing on
  one via the generic BSP/clipping pipeline is tolerated, not designed
  for). Deliberately settling an islet, connected back to the mainland by a
  causeway/bridge, is a follow-up.
- **Coastal & water character v2** — one follow-up spec, all in
  `src/gen/terrain/` (same-seed water shifts → `GENERATOR_VERSION` bump).
  Reference case: seed 2908896298 large/bay/river/lakes/islands.
  - *Coastal detail band*: bare coastlines are one smooth low-frequency
    arc — boring. Add a medium-frequency domain-warped noise octave
    concentrated near the waterline for natural inlets, headlands, coves.
  - *Lakes are inland lakes*: the metro-center radial dip often lands in
    sea/river on coastal maps and merges into the bay (accidental — and
    currently the only thing making coasts interesting). Constrain basins
    to land away from coast gradient and river corridor, and break the
    uniform-blob shape (stronger shore noise, chained sub-basins).
  - *Rivers meander and pool*: courses read as near-straight lines,
    especially on large maps. Meander wavelength control (min
    self-distance; real meanders run ~10× channel width — oxbow-tight
    loop repro: seed 2882370099 inland/small) plus deliberate lake-like
    carve-outs along the course (pools/widenings, the look that today
    only happens when a lake accidentally intersects a river).
  - *Archipelago islands*: islet candidates sample uniformly over all
    water, so a large bay gets one lonely 300 m dot. Sample in an
    offshore band along the coast, scale count with wet area, vary radii
    — islands as a coastal feature with intent, no extra knob.
- **Ships and harbor props** — ocean-going vessels, docks, shipping infrastructure.
- **Transit lines** — rail/metro/monorail layer. Good v2 candidate for
  sector maps.
- **3D anything.**
- **VTT export formats** (Foundry / Universal VTT with walls & lighting
  data) — data model deliberately keeps wall/door semantics so this stays
  possible.
- **Poster-tiling PDF** for printing battlemaps across multiple pages.
- **Blueprint theme** — third theme; cheap once theme system exists.
- **Better label placement** — v1 ships good-enough overlap heuristics.
- **Annotation layer + JSON override export/import** — user labels, markers,
  renames stored as diffs against generated state (spec §3). Follow-up plan
  after sector v1 ships.
- **Tile-based rendering** for metroplex scale — only if SVG performance
  actually hurts.
- **Zone-mix knob** — spec §4 lists zone mix weights as a district knob;
  v1 UI only exposes corp dominance (zoning derives the rest).
- **PNG resolution knob** — spec §3 calls for a resolution knob; v1 export
  is fixed at 2x.
- **Hierarchical per-entity naming** — spec §3 specifies `hash(seed,
  entityId)` per name; v1 draws all names from one sequential RNG stream
  seeded once. Switching later renames everything on existing URLs —
  needs a `GENERATOR_VERSION` bump when it happens.
- **Road/building id format overflow** — ids are fixed-width
  (`A99`/`S999`/`BLD999999`); a large enough sector (e.g. size 8) can
  exceed the padding and produce colliding/malformed ids.
- **Massively extend flavor-pack name tables** — current tables are ~10
  words each, so names repeat quickly across a map. Grow every table
  (adj/place/corpA/corpB/street/venue) by an order of magnitude in both
  packs, and add more patterns per name kind for variety.
- **Name uniqueness check** — generator draws names independently, so
  duplicates like two "Club Afterlife" on one map happen. Track used
  names per sector and retry (or draw without replacement) so every
  district/POI name is unique within a map. Deterministic retries only —
  same seed must still give same names (`GENERATOR_VERSION` bump).
- **POI category filters** — toggle POI types on/off on the map by
  category (e.g. pleasure/nightlife, corp headquarters, medical,
  commerce, underworld — exact categories to be worked out). Flavor-pack
  poi types get a category field; the UI gets per-category visibility
  toggles. Display-layer only, no generation change.
- **Cursor-anchored zoom** — wheel zoom should keep the point under the
  mouse cursor fixed while zooming in/out; currently the view jumps
  around because zoom scales from the transform origin.
- **Cursor styling** — default pointer over the map; the grab hand only
  while actually dragging (currently the hand shows permanently).
- **Curved highways** — the highway strip stays straight; a gently bent
  highway corridor is a cheap follow-up on the corridor mechanism.
- **Street-fabric performance** — per-building polygon clipping; profile
  before optimizing.
- **Improved building placement** — building lots are a rotated rect grid
  clipped to the block polygon, which works for grid-like blocks (many
  small buildings — fine, reads urban) but fails in organic blocks:
  winding streets leave big weird-shaped clipped leftovers that get kept
  as huge irregular buildings. Revisit placement so building size/shape
  responds to block character (organic blocks → small buildings tracing
  the street edges, courtyards, gap-toothed rows), and let placement
  inform building KIND — POI assignment currently ignores footprint size,
  so e.g. bars land in enormous buildings. Size/shape-aware building
  semantics (what fits where) is the follow-up spec's core question.
- **Reroll loading feedback** ✅ — generation moved to a Web Worker; a
  dimmed "Generating…" overlay covers the map while busy and pan/zoom stay
  interactive throughout (see `src/app/genWorker.ts`, `MapView.tsx`).

## Cross-cutting

- **Single tag-cloud UI** — present all tags as one cloud (as popular
  generator tools do) instead of labeled group rows; exclusivity and
  dependency rules (landform group exclusive, piers ⇒ water) enforced
  within the cloud. Pure UI change — the composable tag semantics
  already exist underneath.

- **App styling** — the UI currently has no design at all: components use
  ad-hoc inline `style={{…}}` props (KnobPanel, MapView, App, error
  boundary) and browser-default widgets. Replace with a proper stylesheet
  (plain CSS file is enough — no CSS-in-JS dependency) and give the app
  chrome an actual look (dark cyberpunk panel to match the neon theme,
  styled sliders/selects/buttons). Inline styles should survive only where
  values are computed at runtime (e.g. the map transform).

- **Multi-language UI** — English first, German second. UI strings are
  externalized from day one (no hardcoded labels in components) so adding
  German is translation work, not refactoring. Generated map content
  (district/POI names) is flavor-pack territory, not UI i18n.

## Open questions

- Custom domain (sprawlforge.*) — decide when Pages deploy exists.
- Community flavor packs — loading third-party pack JSON from file/URL.
