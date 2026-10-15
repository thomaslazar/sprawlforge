# Arterials: Connect, Shores, Ramps, Curves — Design

Status: approved (design conversation 2026-10-12)
Branch: `spec/arterials` (off `main` d2215e3, after the perf round)
Depends on: `docs/specs/2026-09-29-tensor-streets-design.md` (field + tracer),
`docs/specs/2026-10-02-cyberpunk-layer-design.md` (rings, spokes),
`docs/specs/2026-10-06-cyberpunk-part2-design.md` (frontage, interchanges).

## 1. Goal

The arterial network should read like a real city's main roads: every
arterial ends on something, the main roads flow in curves instead of
kinking, waterfronts carry a road (but not slavishly), the highway is
reachable from the arterials that reach it, and planned areas come out as
grids that run into organic areas where the style map changes.

Observed on seed 42 coastal/river with the arcology tag (the trigger): 24
arterials traced on the west peninsula, 5 survived the prune, one
1.5 × 2.5 km residential district with 203 blocks; 5 of 21 arterial ends at
water; corners from backtrack snaps, straight decks and joins.

User decisions:

- Invented connector geometry is fine as long as it is deterministic per
  seed and URL.
- Grid vs organic is decided by zone type, varied by the seed. No tag.
- An arterial reaching water turns into a waterfront road by default; it
  may set back or pull away for stretches so it is not a 100 % shore
  trace; a few ends stay dock ends.
- Half interchanges (ramp pair at a T end on the highway, and by chance at
  crossings) are part of this round.
- Approach 3 of the three offered: fix inside the tracer (field learns
  about water, stop rule becomes join rule, smoothing pass), not a patch
  pass after tracing and not a tracer rewrite.
- Three phases, each merged on its own: (1) join rule, smoothing, style
  map; (2) shores; (3) half interchanges. Every seed re-rolls
  (`GENERATOR_VERSION = 9` in phase 1; phases 2 and 3 keep 9 since nothing
  is deployed in between).

## 2. Style map: grid vs organic (phase 1)

Districts and zone types are derived AFTER the arterials (districts are
the cells between arterials), so the style must come from the field and
the zone must follow the style. The visible result is what the user asked
for: a corporate core on a grid, residential sprawl organic, both from one
seeded map.

- The seeded irregularity map `effectiveIrregularity(params)` (zoning.ts)
  stays the single style source. `irr < 0.4` is *planned*, `>= 0.4` is
  *organic* (the noise basis already switches at 0.4).
- `buildPatches` (field.ts): a planned patch (irregularity at its centre
  < 0.4, not a shore patch) takes the angle of its *plan cell*: the
  1500 m lattice cell containing the patch centre. Plan cells are drawn
  lazily from the `'patches'` rng stream in patch order (which is row by
  row): with probability 0.7 the cell copies the angle of an already drawn
  neighbour (west first, else north), otherwise it draws a fresh angle, so
  grids span several cells and still change angle now and then. Organic patches keep today's rule (shore copy
  or random). Shore patches keep the shore tangent.
- The 100 m seam blend between patches and the noise basis (weight 0 below
  0.4) are unchanged; they are the transition between a grid and the
  organic area next to it.
- Zoning follows the style: `assignZones` computes the district's
  effective irregularity first and multiplies the draw weights: `irr <
  0.4` → corp × 2, industrial × 1.5; `irr >= 0.6` → residential × 1.5,
  slum × 2. `zoneWeights(params, shore, irr)` gets the third parameter.
- Planned arterials have no bends because the field is uniform there;
  junctions are right angles because the minor axis is perpendicular. No
  special casing.

## 3. Join instead of stop (phase 1)

Today `traceHalf` stops at a near-parallel road ahead (`hitPar`), at a
field singularity, at an obstacle, at water, at the window, at the river
when it cannot bridge, and `pruneDangling` deletes the tail. New rule for
arterials (`opts.bridgeRivers`): a walker that would stop joins instead.

### 3.1 Connector curve

`joinCurve(p, dir, target, tangent)` in a new module
`src/gen/streets/join.ts`: a cubic Bézier from `p` leaving along `dir`
to `target`, arriving at 60° to the road (from `p`'s side, continuing in
the travel direction along the road; a walker already heading into the
road more steeply than 60° arrives along its own heading, so a grid T
stays straight): with D = |target − p|, controls
`p + dir × D/3` and `target − arrive × D/3`, sampled every 10 m (at least
4 points). `target` is a point on the road being joined, `tangent` that
road's direction at `target` (not at the foot of the walker's
perpendicular; on a curving road the two differ). The fixed arrival angle keeps every join a
proper T, never an acute Y merge. It is the one connector shape used
everywhere in this spec (in-trace join, end pass, and in phase 3 the T
end). A join of 40 m or less (`JOIN_SNAP`) is a straight connector
instead of a curve (a cubic that short dips into whatever lies beside
it). The curve is rejected (returns null) when any sample is in water,
inside an obstacle, outside the window, or within 0.15 × separation of
a near-parallel arterial other than the target, or when any piece of it
crosses or touches an arterial or ring (`crossingGuard`, a segment query
on the index): the target road counts too, except on the last piece (the
last 10 m land on it), and the road the curve leaves is exempt on the
first piece only. A join curve never makes a lens or a knot with another
arterial. A curve whose first such crossing is a third arterial or ring
(not the target, not its own road), crossed at 25° or more
(`angleGapLines`, the 'no acute arterial merges' bound) after at least
20 m of curve, is not refused but truncated there: it lands on that road
as a T, which becomes the join target (anchored end, pinned re-smooth;
the end pass skips it when the road's other end already sits on that
road). The highway is not a blocker here — arterials cross it anyway
and `highwayCrossings` decks them.

### 3.2 In-trace join on a near-parallel road

When `hitPar` fires for an arterial walker and the hit is an arterial or a
ring (never the highway, never its own source within the source window),
the walker joins: `target` is the point on the hit road `0.5 × sep` of arc
ahead of the foot in the walker's travel direction (clamped to the road's
end), the curve from §3.1 is appended, and the half ends on the target. If
the curve is rejected the walker stops as today (the end pass handles it).
The walker joins only a road it is converging on (foot ahead, distance
not growing since the last step, heading into the road's line at 5° or
more), never one it is leaving and never an exactly parallel neighbour (a
planned grid: the walker stops as before). A hook needs a walk: the join
is allowed only after the walker has run at least `0.5 × sep`
(`HOOK_MIN_WALK`, 200 m for arterials) in this half; a near-parallel hit
before that stops the walker as before (a hook at the seed is a curve,
not a road). An arterial
whose two ends land on the same road and that is shorter than 3 ×
separation is a crescent (a U-turn that joined back): dropped in
`traceStreamline`. Streets (`!opts.bridgeRivers`) keep the existing
foot-snap rule.

### 3.3 Turn clamp for arterials

`MAJOR.maxTurn = 15°` per 10 m step (highway-style clamp) so that the
shore steer (phase 2) and field bends come out as curves. The singularity
stop (`SINGULARITY_TURN`) must still apply to arterials: `TraceOpts`
gains `stopAtSingularity?: boolean`, default `maxTurn === undefined`;
`MAJOR` sets it true. A clamped hairpin at a singularity is still a loop,
so the stop keeps priority over the clamp.

### 3.4 End pass

`joinFreeEnds(arterials, terrain, sizeM, index, obstacles)` in join.ts,
run in `traceRoads` after `joinRiverStubs` and before `pruneDangling`:
for every arterial end (both ends of every non-ring arterial) that is not
on the window edge, not within 6 m of another arterial or ring, not a
water end (within 15 m of water), find the nearest arterial/ring point
within `1.5 × MAJOR.separation` (600 m) whose direction from the end is
within 90° of the end's heading (the last 20 m of the road), excluding
the road itself and points within 30 m of the target road's ends; try the
§3.1 curve to it; if it succeeds, append it to the road (points,
direction preserved). Candidates are one per target road (its nearest
segment), tried nearest first, at most 8 (`END_TRY`); a target the
road's other end already sits on is skipped (that join would be a
hairpin), and so is a candidate whose connector would turn more than 90°
in total (`JOIN_MAX_TURN`, computed before the curve is built: some
tangent of the connector is parallel to its chord, so it turns at least
the angle from the end's heading to the chord plus the angle from the
chord to the §3.1 arrival direction at the target; an S-bend counts). An end that cannot be joined stays free and `pruneDangling`
cuts it as today (last resort; see §7 for the ratchet). The index is
updated after each join so later ends can join appended curves, and the
pass repeats up to three times until a pass joins nothing.

### 3.5 Pipeline order (phase 1)

`traceRoads`: field → highway → landmarks (spoke seeds trace outward
only: inward of a spoke is the plaza) → frontage → arterials
(in-trace join, each streamline smoothed before it is indexed) → cross
arterials (same) → finalize (trim stubs, truncate unlandable; no second
simplification — a road is smoothed before it is indexed, never after)
→ `joinRiverStubs` (joined roads re-smoothed, pinned) → `joinFreeEnds`
(same) → `pruneDangling` (last resort) → streets (smoothed before
indexing, 25 m).

An arterial's in-trace river deck keeps its 0.3 × sep clearance from
every road of its rank or higher except the arterial it lands on: the
first arterial its straight dry extension meets within 120 m past the far
bank (`DECK_LANDING`) at 45° or more; the road then ends on that road (a
T, anchored), not on the bank. The bridge itself covers only the water
plus the usual 15 m landing: `markWetSpans` keeps an arterial's dry end
piece at any length, so the stretch from the deck to the landing road is
drawn as road, never dropped (a gap) and never decked.

The highway blocks a river deck only over the water (`highwayBlocksDeck`,
bridges.ts), and only by a deck-on-deck crossing or by a highway segment
within 45° of the deck inside the clearance; a deck may cross the highway
square (never along it or over its deck) on dry land.

## 4. Smooth corners (phase 1)

`smoothBends(points, minRadius, pinned?)` in `src/gen/streets/smooth.ts`:
every interior vertex whose turn exceeds 15° is replaced by a circular
arc tangent to both adjacent segments with radius `minRadius` (arterials
60 m, streets 25 m), sampled every 10 m; where the adjacent segments are
too short for the tangent length, the radius shrinks to the largest that
fits (tangent length at most half of the shorter adjacent segment). Both
endpoints are never moved; a vertex for which `pinned(v, t, arc)` is true
(t the tangent length, arc the sampled fillet that would replace v) is
kept as is. Ramps, frontage and the highway are untouched (the highway has its
own clamp, ramps are Béziers, frontage is an offset).

Invariant: **a road is smoothed before anything ends on it, and never
after.** `traceLayer` smooths every streamline right before `index.add`
(`TraceOpts.smoothRadius`: `MAJOR` 60, `MINOR` 25, highway undefined).
`joinRiverStubs` and `joinFreeEnds` re-smooth only the roads they
changed, pinning a vertex only when another road's end within t + 6 m
of it would end up more than 2 m (`PIN_SLACK`) off the fillet; an end
the fillet barely moves stays anchored (ends are accepted within 6 m)
and the corner is still rounded. Junctions stay sharp by construction: a T adds no vertex to the
road it meets, and a road's own ends are never moved.

## 5. Shores (phase 2)

### 5.1 Shore profile

`shoreProfile(params)` in field.ts: two seeded 2-D noises (`hashSeed(seed,
'shore-setback')`, `hashSeed(seed, 'shore-gap')`, scale 600 m): the
*setback* `s(p) = 30 + 120 × n1(p)` metres, and the band is *off* where
`n2(p) > 0.6` (30 % of the shore, in stretches of a few hundred metres;
measured: the threshold 0.7 first written here switches only 18.5 % off,
0.6 switches 30 %). Both are evaluated at the walker/point position, not along the
shore, which is good enough for 600 m waves.

### 5.2 Boundary basis

`boundaryBasis` weight is a tent: `dist / s(p)` up to the setback (0 at
the water, 1 at the setback), then `1 − (dist − s(p)) / 150` (0 again 150
m past it), and 0 where the band is off. The first formula written here,
`1 − |dist − s| / 150`, contradicted its own prose (it is not zero at the
water when the setback is under 150 m). Reach is 300 m for the tangent
lookup (was 250). The mid-river weight is unchanged (`1 − dist / 250`).
Shore patches (`SHORE_DIST = 300`) are unchanged.

### 5.3 Shore steer in the tracer

In `traceHalf`, arterials only, after the singularity test and before the
water stop (the steer is evaluated on the raw direction, and the
singularity stop compares raw against the previous raw direction while
steering, so a steer turn is not read as a singularity): when the point
`p + dir × 60` (probed along both `dir` and `rawDir`) is in water (not a river band the walker may bridge) and
the walker is not already a dock walker: roll `rng.chance(0.15)` once per
half (`dockDecided` flag) — on success the walker is a *dock walker* and
walks on to the bank and stops there (dock end, kept by the prune as a
water end); otherwise the raw direction for this step is replaced by the
shore tangent at `p` (sign closer to `dir`), and the clamp (§3.3) turns
the walker over several steps. Once the walker is within the band the
boundary basis keeps it along the shore; where the band is off the field
pulls it inland and the steer fires again when water comes ahead. The
river bridge rule runs first and is unchanged. The dock roll draws from
the arterial rng stream passed to `traceHalf` (one draw per water
approach, so seeds stay reproducible). The net turn of a steer is capped
at `SHORE_MAX_TURN = π` (180°) as a backstop; on a straight shore field it
never binds because the singularity stop fires first, a field that curves
along a lake could still need it. A river is steered around with
`RIVER_STEER_SLACK = 60` m of slack on the deck decision.

The highway gets the same steer, never a dock: with `HIGHWAY_OPTS` the
lookahead is 300 m (the spec's first 200 m is shorter than the highway's
300 m turning radius; 200, 250 and 400 each fail a highway test) and the
turn follows the highway's own clamp, so a
coastal highway that would run into the sea bends along the coast and
exits on an adjacent land edge (R11 adjacent-edge rule) instead of
stopping dry at the beach (38 of 200 swept coastal 2 km cases at the phase 2 start, 29 in the first
draft of this text;
as built: 18, ratchet in `highway.test.ts`; user
seed 1584279735 coastal/small/sparse/corp-run/normal/mixed/river ended at
696,1740 pointing at the sea). `traceHighway` keeps its entry-edge
search; an attempt that reaches any edge beats one that stops.

Phase 2 as built (decisions beyond the text above, all pinned in code):

- Highway probe: a marched 10 m probe finds the first wet point inside the
  300 m window (highway only; arterials probe one point at 60 m).
- Deck cap `HIGHWAY_DECK_MAX = 350` m (seed 3 had a 440 m deck over the
  river mouth); `deckMax: 0` after the highway's one bridge.
- At a river too wide to deck the highway steers upstream: the sign comes
  from the narrower `riverSpanAt` measured 200 m along the bank.
- `HIGHWAY_STEER_HOLD = 600` m: the steer is held until the ray 600 m ahead
  along the field heading is dry (or hits a river narrow enough to deck).
- R11 ranking puts an attempt that comes back to its entry edge (a
  hairpin) last; R12 is the approach heading over the last 50 m.
  `traceHighway` draws every entry axis and position up front so the rng
  stream does not depend on which attempt wins.
- Sweep ratchet 38 → 18 of 200 coastal cases still end inside the window
  or on the entry edge; 16 of 200 swept cases (of the 18 that still stop inside) are steer-outrun dead ends on
  concave 2 km coasts (lookahead 300 m against the turn room).
- Frontage end extension takes its tangent from a 30 m chord (a 10 m chord
  folded at a highway kink).
- Measured on P1 seed 42: longest arterial run within 150 m of the sea
  580 m, water ends 3 of 84, longest bare shore stretch 975 m.

### 5.4 Expected look

Coasts and lakes carry an arterial 30–150 m inland for most of their
length, with gaps where the road wanders inland for a block or two and a
few dock ends in between. Local streets fill the band between road and
water (they stop at water as today).

## 6. Half interchanges (phase 3)

### 6.1 T ends on the highway

In `joinFreeEnds`, an arterial end that found no join candidate (§3.4)
and whose road crosses the highway: the road is cut at its last highway
crossing (the crossing point becomes the end; the tail beyond it goes)
provided the remaining road is at least 300 m and the crossing is at 45°
or more; such ends are *T ends*. Otherwise the end stays free (prune). A
T end counts as anchored for `pruneDangling`'s arterial pass (accept
`highway` only when the end lies within 1 m of the highway centreline;
new `PruneOpts.acceptEndOn?: (cls, p) => boolean` or equivalent).

### 6.2 Ramps

`buildInterchanges` (highway.ts):

- `highwayCrossings` reports a crossing for an arterial ending on the
  highway (`t` of the end) with `tee: true`.
- Full interchanges are chosen as today (4 ramps, never at a tee).
- Every tee crossing gets a *half interchange*: the two ramps of the
  arterial's side (`rampTriples` restricted to the side where the
  arterial lies), `half: true` on the crossing, if the ramps fit and the
  crossing is ≥ `IC_REACH_M` from every chosen interchange; otherwise the
  tee stays a plain T end (the arterial still ends on the highway, no
  ramps — a plain end on an elevated or sunken highway is an under/over
  pass stub, accepted).
- Chance ramps: every remaining non-tee crossing that is square enough,
  continues on both sides and is ≥ `IC_REACH_M` from every interchange
  or half interchange gets a half interchange with probability 0.25
  (rng `hashSeed(seed, 'half-interchanges')`, crossings in highway
  order), on the side drawn by the same stream (the side must fit).
- Ramp ids continue the `R<n>` sequence; ramp count = 4 × full + 2 × half.

### 6.3 Render

Half interchanges render like full ones (ramps are roads). No new SVG
attributes; `data-ramps` counts both.

### 6.4 As built (phase 3)

- The tee sweep (`teeEnds` in `join.ts`) runs after the join passes: an end
  that still has no junction is cut at its nearest highway crossing. The
  tail-junction rule: the sweep refuses when any other arterial lies within
  6 m of the tail beyond the crossing (the tail then ends at a real
  junction, the old end pass handles it). `TEE_MIN_M = 300`,
  `TEE_MIN_ANGLE = π/4`.
- `PruneOpts.anchorEnd?: (p) => boolean`: `traceRoads` passes
  `distToPolyline(p, highway) <= 1`, so a tee end counts as anchored.
- `TEE_SNAP_M = 2` (`join.ts`, imported by `highway.ts`): the highway is
  simplified at 1 m after the cut, so a tee end can sit up to 1 m off the
  centreline; 2 m is the tolerance for "rests on the highway" in
  `highwayCrossings`.
- A tee gets its half interchange by level, with no rng: the kind follows the
  highway level at the crossing (over / under), and there is no ground-level
  special case.
- `siteOk` (dry highway point, clear of level transitions, `IC_REACH_M` from
  every chosen interchange, halves included) is shared by full and half
  interchanges; `rampTriples(c, sides)` takes the sides to build.
- Order: tee halves first, then chance halves (`HALF_CHANCE = 0.25`, stream
  `hashSeed(seed, 'half-interchanges')`), both in highway order; the side is
  drawn once (no second try on the other side). Ramp ids follow that order.
- Measured (seed 42): P1 (`coastal,medium,dense,fringe,lively,mixed,river`)
  3 full + 1 tee half, 0 chance halves, 14 ramps; planned
  (`inland,planned,corp-run`) 3 full + 1 chance half, 14 ramps (was 12);
  P3 prune 27 → 26 (still over the 20 bound; see ROADMAP).
- Infill (found while re-pinning): a cut that is a short hook with both ends
  on its face ring is dropped, and a welded infill remainder is never dropped
  for its length (both left sliver blocks / block sides without a road).

## 7. Tests and checks

- `smoothBends`: a right-angle polyline becomes an arc of the requested
  radius with sharp endpoints; short legs shrink the radius; a straight
  line is unchanged.
- `joinCurve`: leaves along `dir`, ends on target, null on water/obstacle.
- Model seeds (`temp/perf/sets.mts` is scratch; the test file carries its
  own copy of the 12 parameter sets): every arterial end is on the window
  edge, within 6 m of another arterial/ring, on the highway (T end, phase
  3), or at water; the arterial prune (`TracedRoads.pruned`) fires at most
  20 times per seed (10 until rule C1; raised by the user, who prefers a
  pruned end to a connector turning more than 90°) — a ratchet that
  only tightens from here; the ideal is 0, the
  rest are the last-resort cases of §3.4 (plaza in the way, water, window
  edge, hairpin, nothing in reach). Measured at phase 1: 0–9 per seed.
- Curvature, not angle: the clamp fixes 15° per 10 m step and the 1 m
  simplification before smoothing merges steps, so at every interior vertex (farther than
  15 m of arc from either end, shorter adjacent leg over 10 m — a kink
  shorter than that is invisible at map scale) the bend is at most
  `max(15°, 2° × shorter leg in m)` and never over 45°; ring roads (an
  octagon by design) are exempt.
- Phase 2: on P1 (seed 42 coastal/river) at least one arterial runs ≥
  400 m within 150 m of the sea; at most 20 % of arterial ends are water
  ends; the band-off stretches exist (some shore length > 300 m has no
  arterial within 150 m).
- Phase 3: ramp count = 4 × full + 2 × half; every tee crossing is at 45°
  or more; the existing `ramp count is four times` test is replaced.
- Existing pins (block limits, arterial counts, names) are re-pinned once
  per phase as "arterials re-roll (v9)".
- uicheck: three scenes in `tools/uicheck/check.mjs` — `arterials-grid`
  (`seed=42&tags=inland,planned,corp-run`: ≥ 20 junctions, screenshot),
  `arterials-coast` (`seed=42&tags=coastal,river,arcology`: ≥ 1 bridge,
  screenshot), and the shot is looked at. Phase 3 asserts `data-ramps` ≥
  6 on the planned scene.
- Perf: seed 42 coastal/river 4 km within +15 % of main in the container
  (median of 3; `temp/perf/time.mts`).

## 8. Out of scope

- Whole water handling rework (ROADMAP, later).
- Street-level smoothing beyond the 25 m pass; alleys; lots unchanged.
- A user-facing grid/organic tag (user chose zone-driven).
- Tributaries, confluences.

## 9. Roadmap

Remove "Half interchanges" and "Arterials at water fronts" from
`docs/ROADMAP.md` when phases 3 and 2 merge; add "arterials: planned-cell
angle sharing across more than two neighbours" only if phase 1 grids come
out too small.
