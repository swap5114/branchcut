# Decisions

One entry per phase: the decision, the other options, and why we chose this one.

## Phase 0: Tooling

**Decision:** TypeScript run directly by Node (type stripping). `tsc` only checks types.
**Other options:** compile with `tsc` to `dist/` before every run.
**Why:** no build step, no second copy of the code. The cost: we cannot use TypeScript-only syntax like `enum`. That is fine for small, plain code.

**Decision:** the core has zero dependencies.
**Why:** the same merge code runs in Node and in the browser, and every line can be explained.

## Phase 1: Data model and editing operations

**Decision: times are whole frames (integers).**
**Other options:**
- *Float seconds* (4.3333…). Rejected: see below.
- *Integer milliseconds.* Rejected: at 30 fps one frame is 33.333… ms, so frames still do not land on whole numbers.
- *Rational numbers* (for example 1001/30000 s, used by pro formats like OpenTimelineIO and FCPXML). Exact at any frame rate, but heavier to store and compute. We do not need them while one timeline has one frame rate.

**Why whole frames:**
1. **A frame is the smallest real unit of video.** You cannot cut between two frames, so a time like 4.31 s means nothing on screen. Integers make "between frames" impossible to write.
2. **Floats are not exact.** A computer cannot store 1/30 exactly, and `0.1 + 0.2` is `0.30000000000000004`. After a few ripples, two clips that should touch end up with a tiny gap or a tiny overlap.
3. **Diff and merge need exact equality.** "Did this clip change?" and "is this shift exactly the size of the deleted clip?" are `===` checks. With floats, `24 - 10` might not equal `14` after some steps, so ripple detection and the overlap check would give false results.
4. **Hashes need exact values.** In storage (Phase 4), `4` and `4.0000000001` give different hashes, so an unchanged clip would look changed and get stored again.

**Limit:** `fps` is a whole number, so 29.97 fps (NTSC) is not supported yet. The fix would be to store fps as a fraction (30000/1001) while keeping clip times in whole frames.

**Decision: clips are stored as a map of stable id → clip, not as a list.**
**Other options:** an array of clips per track, matched by position or by content.
**Why:** diff and merge must know "this is the same clip" in two versions. With an array, a ripple delete moves every later clip to a new position, so everything looks changed. Matching by content fails when a clip is edited. A stable id says "same clip" no matter where it moved or what changed. Git has lines as its unit; we have clip ids.

**Decision: every edit returns a new timeline and never changes the old one.**
**Other options:** change the timeline in place (faster, less memory).
**Why:** a version system keeps old versions. If an edit changed the old object, history would break silently. Unchanged clips are shared between versions (same object), so this is cheap. Phase 4 builds on this sharing.

**Decision: an edit that would make two clips overlap on one track is refused.**
**Other options:** overwrite the clip underneath, like many editors.
**Why:** it keeps one simple rule true on every branch: no overlaps. So in the merge, any overlap is new and was made by combining two branches, and we can ask about it.

**Decision: ripple edits move the clip's own track plus every sync-locked track.** A clip crossing the cut is trimmed. A clip covering the whole cut gets shorter.
**Other options:** split the covering clip in two.
**Why:** a split would invent a new clip id as a side effect of a ripple, and that makes merging harder.

**Decision: split keeps the id on the left part; the right part's id comes from the source frame of the cut** (`p1@240`).
**Other options:** a random id.
**Why:** the left part keeps edits from other branches. A source-frame id stays the same after ripples, and two editors making the same cut get the same id, so their work matches in the merge.

## Phase 2: Diff that speaks like an editor

**Decision: intents are inferred from two snapshots (before, after), not recorded from the edit operations.**
**Other options:** save the list of operations with each commit ("rippleDelete(p2)") and print it.
**Why:** a snapshot diff works for any two versions: across 10 commits, after a merge, or when an AI agent or an API client sends only the final timeline. An operation log breaks in all of these cases, and we would have to trust every client to log honestly. Git works the same way: it diffs files, not keystrokes.
**Cost (known limit):** it is a guess. A clip moved by hand by exactly −10 s, next to a 10 s ripple delete, is counted as part of the ripple.

**Decision: two levels.** Level 1 (added / removed / modified + changed field groups) is exact and simple; the merge is built on it. Level 2 (sentences) is only for people, and never decides anything in the merge.
**Why:** if the wording rules have a bug, the result is a strange sentence, never a wrong merge. The one piece of Level 2 the merge reuses is `rippleShifts()` (which clips only slid because of a ripple).

**Decision: field groups, not single fields.** `in` + `out` = trim, `track` + `start` = placement, one group per property.
**Why:** a group is one editing intent. The merge takes or rejects whole groups, so it never mixes half of Aditi's trim with half of Rahul's.

**Decision: every sentence "uses up" the changes it explains.** Ripple first, then split, then the rest.
**Why:** each change is said exactly once. A ripple delete gives 1 sentence, not 6. But a moved clip's other changes (grain on Point 3) are still reported.

## Phase 3: Three-way merge

**Decision: merge clip by clip, and inside a clip, field group by field group.**
**Other options:** merge whole clips (any clip changed on both sides = conflict); or merge single fields.
**Why:** whole clips give false conflicts (Aditi's move + Rahul's grain on Point 3 would clash). Single fields give broken results (Aditi's new `in` with Rahul's new `out`). A group is one editing intent, so it is the right unit.

**Decision: ripple shifts add up (new start = base + ours shift + theirs shift).** Only when at least one side's shift is a ripple; two deliberate moves still conflict.
**Other options:** treat any double move as a conflict.
**Why:** a ripple is not an opinion about where the clip goes. It is a side effect of time removed earlier in the film. If both editors removed time, both removals are true, so the shifts add. Without this rule, one ripple on each branch gives dozens of fake conflicts.

**Decision: a clip that only slid in a ripple counts as untouched.** So "Aditi deleted p2, Rahul only rippled it" deletes p2 silently, and says so in a note.
**Why:** the ripple did not mean "I want p2". A real edit (opacity on the laptop) does, so that one becomes a delete-edit conflict.

**Decision: new clips move with their closest anchor (Pass 2).** Anchor = nearest neighbour on the same track, or the clip underneath. Tie → prefer the clip underneath, lowest track first.
**Other options:** leave new clips at their absolute time.
**Why:** a title placed over "Point 3" is about Point 3. If Point 3 moves 10 s left in the merge, a title left behind would sit over the wrong shot. This is the video version of git using the lines around a change as context.

**Decision: overlaps are checked after merging (Pass 3), and only new ones count.** A new overlap = the two clips overlap in the merge but in neither branch.
**Why:** text has no idea of "two things in one place". Video does. Since every branch is overlap-free (Phase 1 rule), any overlap is caused by the merge.

**Decision: the merge is stateless.** Conflicts have stable ids (`edit:title:prop:text`, `delete:laptop`, `overlap:T1:built:chapter`). The caller sends choices keyed by id; the merge runs again from scratch and applies them.
**Other options:** keep a "merge in progress" state on the server, like git's MERGE_HEAD.
**Why:** nothing to clean up, nothing to go stale, any server can answer, and the client can change its mind (the "Change" link). Overlap choices are applied one at a time, and the check runs again after each, because "make room" can push a clip into another one.

**Defaults while a conflict is open:** edit-edit shows ours, delete-edit stays deleted, overlap stays overlapping. The preview is always a real timeline.

## Phase 4: Storage and history

**Decision: content-addressed storage (SHA-256 of canonical JSON).**
**Why:** the same content gets the same hash, so it is stored once, for free. The hash is also a checksum and a stable name (it can be cached forever). Canonical JSON (sorted keys) is needed because `{a,b}` and `{b,a}` must hash the same.

**Decision: commit → tree → 64 buckets → clips.**
**Other options:** store the whole timeline per commit (simple, huge); list every clip hash directly in the tree (the tree grows as big as the project); a deep tree like git folders.
**Why:** a one-clip edit writes exactly 4 objects: clip, bucket, tree, commit (tested). The tree stays a fixed size (64 hashes). Clips go into buckets by a cheap hash of their id, so a bucket only changes when one of its clips changes.
**Honest cost:** the tree is about 4 KB per commit. On the 11-clip demo project that is more than a full copy. It pays off fast with size: 16× smaller at 1,000 clips, 38× at 20,000.

**Decision: pure-TypeScript SHA-256.**
**Other options:** WebCrypto (browser) or node:crypto (server).
**Why:** WebCrypto is async-only and node:crypto does not exist in the browser. One sync implementation runs everywhere. Tested against the "abc" test vector and against node:crypto at every padding edge.

**Decision: refs move only by compare-and-set.** Every commit says which head it expects; if the branch moved, throw "stale head" (HTTP 409 later).
**Why:** without it, two editors saving at the same moment silently lose one person's work ("last write wins"). With it, the loser is told and can merge.

**Decision: the merge writes nothing until every conflict has a choice. A merge commit has 2 parents.** Merge base = nearest common ancestor (walk back from one side until we meet an ancestor of the other).
**Known limit:** criss-cross merges can have two equally good bases; git builds a virtual base, we take the first.

## Phase 5: API server

**Decision: plain node:http with a list of (method, pattern, handler) routes.** No framework; every step is visible.

**Decision: one file per object, `objects/ab/cdef….json`, written to a temp file and then renamed.**
**Why:** rename is atomic, so a crash never leaves half an object. The two-character folder keeps folders small. Objects never change, so the process caches them forever, and `GET /timeline?ref=<commit hash>` sends `Cache-Control: immutable`.

**Decision: refs in one JSON file per project, compare-and-set behind an in-process queue.**
**Scaling story:** with many servers an in-process queue is not enough; refs move to a database and CAS becomes one statement: `UPDATE refs SET head=$next WHERE project=$p AND name=$b AND head=$expected`. 0 rows updated → 409. Objects can stay on disk or move to S3; they are immutable, so they need no locks. Tested: 10 writers racing for the same head → exactly one 201 and nine 409.

**Decision: the merge endpoint is stateless.** Open conflicts → 409 with the list. The client sends the same request again with `choices`.

**Decision: validate at the edge, with messages a person can act on** ("clip p1: out must be after in"). Unknown fields are dropped (they would change the hash without meaning anything). Body limit (8 MB default) → 413. Project ids are checked by a strict pattern before they become folder names. Unknown errors → 500 without internals.

## Phase 6: Benchmark and profiling

**Result:** see the README table. On 1,000 clips: commit ~1 ms (target 10), merge ~7 ms (target 50), storage 16× smaller (target 10×).

**Profiling fixes, by impact** (20,000 clips, before → after: commit 112 → 22 ms, diff 500 → 55 ms, merge 702 → 178 ms):
1. **O(n²) list growth in ripple detection.** Each clip that slid was added by copying the whole group list (`[...list, m]`). A ripple that moves 10,000 clips did ~50 million copies. Fix: `push`.
2. **The overlap check sorted the whole track on every one-clip edit.** Fix: a one-clip edit only checks that one clip against its track (one pass, no sort).
3. **Each commit re-read its parent from storage**, because the commit just written was not cached. Fix: cache the new commit's state right after writing it.
4. **Each commit rebuilt all 64 buckets and re-checked every clip.** Fix: unchanged clips are the same object as in the parent (Phase 1 sharing), so an identity check (`!==`) finds the changed ones; only their buckets are copied and only they are checked.
5. **`Object.entries` on a 20,000-key object** builds 20,000 small arrays. Fix: `for…in` in the hot loops (3× faster).

**What is left:** a one-clip *edit* still copies the clips object (`{...clips}`), about 29 ms at 20,000 clips. The next step would be a persistent map (a HAMT, like Immutable.js). Not needed at the target sizes.

## Phase 7: Demo page

**Design:** an editor's notebook, not a SaaS template. Warm paper and ink, a book serif for headings, system sans for the interface, monospace only for timecodes and hashes. Clip colours are muted per track so the two people's colours (teal and burnt orange) and the red hatching for "needs a decision" stand out. No gradients, glass or emoji. Light and dark themes from the same colour tokens, plus a manual switch.

**Decision: plain DOM with a tiny `h()` helper; re-render everything after each change.**
**Other options:** React or Preact.
**Why:** the page is small, re-rendering is instant, and there is no framework to explain. Focus is restored after each render by a stable `data-key`, so keyboard users keep their place.

**Decision: the merge preview calls the core `merge()`; "Save" calls the repo.** The page never has its own copy of the rules.

**Decision: one self-contained file** (`docs/index.html`, ~56 KB, built by esbuild). GitHub Pages serves `docs/` directly: nothing to host, nothing to break.

**Found by looking, not by tests:** side-by-side branch lanes were too narrow to read, and storage looked bigger than full copies on the tiny project. Fixed the layout; explained the storage number honestly on the page.

**Browser test:** Playwright drives the built file in the local Chrome or Edge (no 150 MB download): the full flow, "appeared after your last choice", save, a real edit, a refused overlap, keyboard focus, phone width with no page scroll, dark theme, reduced motion, the in-browser benchmark, and zero console errors.

## Phase 8: README and interview notes

**Decision: three documents for three readers.** README for the founders and engineers on GitHub (story table first, then ideas, numbers, limits). INTERVIEW.md for Vansh to say out loud (no file names, no code). LOOM.md as a 90-second shot list.
**Why:** each reader wants a different thing. The README leads with the demo story because that is what makes the problem concrete; the limits section is honest because the founders will find them anyway.
