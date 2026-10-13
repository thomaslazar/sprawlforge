# Streets cleanup — design

Date: 2026-10-13. Branch `fix/streets-cleanup` off `main` f27a294 (arterials phase 1 merged).
Diagnosis: `.superpowers/sdd/2026-10-12-arterials/investigation-streets-seed42.md` (items 1–5).
Reference map: seed 42, `coastal,medium,dense,fringe,lively,mixed,river,arcology`, 4 km; also seed
426750495 `inland,small,dense,balanced,quiet,sprawl,river` and seed 2268324149
`coastal,medium,packed,balanced,quiet,planned`.

## 1. Goal

The street layer (traced streets, infill pieces, frontage) has four pre-existing defect classes the
user saw on the reference map: doubled frontage pieces along the highway, streets that end nowhere,
streets that read "thick, then a bit longer", and street bulges/hairpins on arcology rings. Seed 42
has 79 free street ends, 71 of them unintended. This round removes the mechanisms, not the symptoms.
Arterials and the highway are untouched (item 7b of the diagnosis, river ends blocked by the highway,
moves to arterials phase 2). GENERATOR_VERSION stays 9 (nothing shipped since).

Out of scope: buildings (triangles, outcroppings, compound cells) — the building pass follows this
branch. The lot alley at Static Heights is a building-pass item.

## 2. Rules

### 2.1 Stranded streets are judged against the whole network (item 2, 45 free ends)

`infillFaces` drops a traced street "stranded" inside a split face when one of its ends rests on
nothing. Today "nothing" means: not on the face ring, not on an arterial, not on a new piece. Streets
are not consulted, so a through street whose ends sit on two other streets is dropped and everything
anchored on it is left hanging.

Rule: an end counts as anchored when it is within 6 m of **any** road (arterial, street, infill
piece, ring, frontage) other than itself, on the window edge, or within 15 m of water. Frontage roads
are exempt (their ends rest on the window, water or an obstacle by construction). The check runs to a
fixpoint: a street resting only on a dropped street goes too. Surviving interior streets are fed into
the sub-face graph so a through street divides the sub-blocks.

### 2.2 One final street prune (item 5)

After infill, streets and infill pieces are pruned once more against the complete road set
(highway, arterials, ramps, streets, infill): `pruneDangling` with `minLength 60`, the decay
cul-de-sacs kept. An end resting on another street's end counts as anchored here (not `interiorOnly`):
blocks were already cut along such chains, and trimming one leaves a block side with no road. `traceRoads` returns its decay ends (`decayEnds: Pt[]`) so the keep set
is the real one; the ponytail note in `withTrimmedFrontage` goes with it.

Order in `generateSector`: infill → converge-and-weld (2.4) → final prune → blocks → `markWetSpans`.
Blocks are cut before the weld and the final prune, so neither may delete a road that bounds a block:
infill ends are kept by the prune (infillFaces anchored them), a weld run in the middle of a street keeps both
parts, and only tails that never bounded a block (dangling trees) are trimmed. The `block sides have a road`
ratchet guards this.

### 2.3 One frontage piece per face side (item 1, the doubled pieces along the highway)

`frontageOf` emits one offset segment per face-ring edge that lies along the highway, each extended
60 m past both ends. A curved highway gives 5–6 chords per side that overlap by 60–120 m and fan out
at different offsets (bend, jog, sliver).

Rule: consecutive ring edges along the highway (every vertex and midpoint within 6 m of it) form one
run. A run is offset **as a polyline**: each vertex moves inward along the bisector of its two edge
normals by `FRONTAGE_M / cos(half the turn)` (capped at `2 × FRONTAGE_M`), the run's two end vertices
by their single edge normal. Only the run's two ends extend 60 m. The result is clipped to the ring
and becomes **one** infill road with that polyline. Everything in `infillFaces` that assumed a
two-point piece (run-on `reach`, the 8 m weld, `inCore`) handles a polyline.

### 2.4 Converging streets weld at first contact (item 3, "thick then a bit longer")

Two streets drawn 3–6 m apart read as one wide road, and the one that runs on reads as "a bit
longer". Sources: infill frontage doubles (2.3 removes), infill pieces laid along traced streets
inside the face, traced streets joining a near-parallel neighbour over up to 100 m.

Rule (generic, on the final street set, before 2.2): walk every street in 5 m samples; while
consecutive samples lie within 8 m of any other road (any class but highway and ramp; every road
within 8 m counts, so a short chain piece does not break the run), measure that run by arc length.
A run in which the street crosses that road (samples on both sides of it) is a junction, not a
double, and is ignored: a crossing at 45° already stays within 8 m for 23 m. The doubled-streets
test uses the same run finder (`closeRuns`), so rule and test cannot drift. Frontage and
ring roads are weld targets but are never cut themselves.
A run longer than 20 m cuts the street at the run's first sample, welded onto the other road there.
When the run starts at the street's own start, the part **after** the run is kept instead (welded at
the run's last sample). A remainder under 60 m is dropped. `ponytail:` a run in the middle of a
street keeps only the part before it; the final prune (2.2) handles what that leaves.

Infill twins: a BSP cut that runs parallel (within 15°) to and within 15 m of another piece, a
road inside the face, or the face ring itself (the block's bounding road) over more than 20 m is not
added (seed 42 S415/S416; cuts hugging a bounding traced street).

### 2.5 Rings seed outward; streets have a hairpin rule (item 4)

Street seeds on arcology ring roads (ids `K…`) point outward only: `dir` = the radial direction from
the arcology centre, `axis 'major'`, `oneWay`, the way spokes are seeded. Nothing is seeded into the
band between ring and plaza. The band is not made an obstacle (nothing enters it any more; YAGNI).

Street hairpins: a street whose two ends rest on the same road (within 6 m) with a chord under 40 m
and a length under 80 m is dropped, in `traceRoads` after the street prune. (`dropHairpins` covers
arterials against rings only.)

## 3. Tests

- **Street free ends** (new describe in `generate.test.ts`): a street end counts as free when it is
  farther than 6 m from every other road, not on the window edge, not within 15 m of water and not
  inside an obstacle. Ratchet per reference seed, measured after the round, down only. Decay
  cul-de-sacs are inside the count (the model does not carry them); the comment records how many.
- **No doubled streets**: pairs of streets within 6 m of each other over more than 20 m = 0 on the
  three reference seeds.
- **Frontage**: `frontageOf` unit test on a synthetic concave face along a curved highway: one piece
  per face side, no two pieces within 6 m over more than 20 m. The red `frontage` describe for seed 20
  goes green with no change to its assertions.
- **Rings**: no street has both ends within 6 m of one `K` road; no street sample lies between a ring
  and its plaza unless the street crosses the ring (seed 42 S002/S003 class).
- **Block sides have a road**: every block edge midpoint within 10 m of a road, or within 15 m of
  water, or on the window edge, landmark blocks excepted; ratchet per reference seed (the weld's
  crossing cuts were the bulk of the offenders before the exemption).
- Existing ratchets hold (`no road runs through a block` 18 coast-aligned, block size, street density,
  prune ≤ 20). Re-pins listed with numbers; a ratchet never moves for our changes.
- uicheck: a zoomed scene on the seed 42 highway landing east of the bridge (the user's crop), shots
  looked at.

## 4. Measurement

Before/after per reference seed: free street ends (by cause, as in diagnosis item 5), doubled pairs,
infill piece count, blocks > 60 000 m². Expected on seed 42: free ends 79 → under 15, doubled pairs
50 → 0.
