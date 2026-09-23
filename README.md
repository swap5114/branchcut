# Branchcut

**Branch, diff and merge for video timelines.**
Two editors change the same cut at the same time. Branchcut says what each person changed in editor words, merges their work, and asks only the questions a person must answer.

**Live demo:** https://swap5114.github.io/branchcut/ (one self-contained page; the real engine runs in your browser)

---

## The problem

Code has git. Video has `final_v3_actual (1).mp4`.

Cardboard's hard problem #10 asks three questions:
- What does a diff look like for a timeline?
- How do you show a conflict so an editor can resolve it easily?
- How do people branch, work in parallel, and merge?

Branchcut answers all three with a small engine and a demo. The key move: **version the edit decision list** (which piece of which media file plays where, in whole frames), never the pixels. Media files are only referenced by id.

## The demo story

Both editors start from the same 40-second cut.
Aditi ripple-deletes "Point 2", changes the title, and adds a chapter card.
Rahul trims the intro, grades it, adds grain, changes the laptop shot's opacity, changes the title, and adds two new clips.

| What happened | What Branchcut does |
|---|---|
| Aditi ripple-deletes "Point 2" (6 clips change) | **One** sentence: *Ripple delete "Point 2" (with "Laptop b-roll"): 4 clips moved −10s* |
| Rahul trims the intro by 1 s | *Ripple trim "Intro" (end −1s): 8 clips moved −1s* |
| Both ripples pull "Point 3" left | The shifts **add up**: 24 s → 13 s (−10 s and −1 s). No conflict. |
| Rahul added grain to "Point 3"; Aditi only moved it | The grain survives the move |
| Aditi deleted "Point 2"; Rahul only rippled it | Deleted by itself, with a note saying why |
| Aditi's cut removed the laptop shot; Rahul changed its opacity | **Question:** *Delete it* / *Keep Rahul's edited version* |
| Both changed the title text | **Question:** *Keep Aditi's "Ship week"* / *Keep Rahul's "Launch week 2026"* |
| New titles and b-roll were placed over "Point 3" | They move with "Point 3" in the merge (−1 s and −10 s) |
| Aditi's and Rahul's new titles now cover the same second | **Question:** *Make room* / *Drop one* (text merging has no such rule) |
| You choose to keep the laptop shot | 2 new overlaps appear, marked *appeared after your last choice* |
| Everything answered | *Save merge to main* creates a merge commit with 2 parents |

Result: 10 edits across two branches (20 changed clips), 3 questions.

## Four ideas

1. **Clips have names, not positions.** Every clip keeps one id for its whole life, so the diff can say "Point 3 moved and got grain" instead of "everything after 14 seconds changed". Changes are compared in **field groups**, one per editing intent: placement (track + start), trim (in + out), media, effects, and one group per property.

2. **Ripples add up.** A ripple is not an opinion about where a clip goes; it is a side effect of time removed earlier. If both editors removed time, both are true. So when a clip's start changed on both sides and at least one change is a ripple: new start = base + ours shift + theirs shift. Two deliberate moves of the same clip still conflict.

3. **New clips keep their context.** Git uses the lines around a change as context. A new clip finds its closest anchor on its own branch: a neighbour on the same track, or the clip it sits on top of. When the anchor moves in the merge, the new clip moves with it.

4. **Time is checked last.** After merging, any two clips that overlap on a track, and did not overlap on either branch, become an overlap conflict. Choices can create new overlaps (making room pushes clips), so the check runs again after every choice.

The diff is inferred from two snapshots, not from a log of operations. So it works across many commits, after a merge, and for edits made by an AI agent or an API client that only sends the final timeline.

## Storage

Like git: every object is stored under the **SHA-256 of its canonical JSON** (keys sorted), so the same content is stored once.

```
commit ─→ tree (fps, tracks, 64 bucket hashes) ─→ bucket (clip id → clip hash) ─→ clip
```

- Clips go into one of 64 buckets by a cheap hash of their id. A one-clip edit writes **exactly 4 objects**: the clip, its bucket, the tree and the commit (tested).
- Saving a commit reuses the hashes of unchanged clips from the parent. Unchanged clips are the same object in memory (edits never mutate), so finding what changed is an identity check.
- Branches are refs that move **only by compare-and-set**: every commit says which head it expects; if the branch moved, the write is refused with the current head (HTTP 409) instead of overwriting someone's work.
- A merge writes nothing until every conflict has a choice. A merge commit has 2 parents.
- SHA-256 is written in plain TypeScript so the same code runs in the browser (tested against the `"abc"` vector and against `node:crypto`).

The fixed cost of a commit is a tree of 64 hashes (about 4 KB). On the tiny 11-clip demo project that is more than a full copy; the demo page says so. On real projects it wins by a lot (below).

## Benchmark

`npm run bench`. Generated projects over 4 tracks. Storage for 100 one-clip commits vs. saving 101 full copies. Merge = two branches that each ripple-delete a clip and change 20 more. Medians, Node 22, a Windows laptop.

| Clips | Full copies ×101 | Stored | Smaller by | Commit | Diff | Merge |
|---:|---:|---:|---:|---:|---:|---:|
| 1,000 | 13.0 MB | 0.81 MB | **16×** | **0.97 ms** | 3.0 ms | **7.3 ms** |
| 5,000 | 66.9 MB | 2.14 MB | 31× | 4.6 ms | 11.7 ms | 32.9 ms |
| 20,000 | 272.4 MB | 7.17 MB | 38× | 22.1 ms | 54.8 ms | 178.1 ms |

Targets on 1,000 clips were commit < 10 ms, merge < 50 ms, storage ≥ 10× smaller.

Profiling the 20,000-clip case found an O(n²) list copy in ripple detection, full-track sorting on one-clip edits, and commits re-reading their parent from storage. Fixing them took commit from 112 → 22 ms, diff 500 → 55 ms, merge 702 → 178 ms. Details in [DECISIONS.md](DECISIONS.md#phase-6-benchmark-and-profiling).

## API

Plain `node:http`, no framework. Objects are files under `objects/ab/cdef….json`, written to a temp file and renamed (a crash never leaves half a file).

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/projects` | `{ id, timeline }` → 201 `{ id, head }` |
| `GET` | `/api/projects/:p/branches` | `{ branches: { name: head } }` |
| `POST` | `/api/projects/:p/branches` | `{ name, from? }` → 201; 409 if it exists |
| `GET` | `/api/projects/:p/timeline?ref=` | branch or commit hash; a hash is `Cache-Control: immutable` |
| `POST` | `/api/projects/:p/commits` | `{ branch, expectedHead, timeline, message }` → 201; **409 + `currentHead`** if stale |
| `GET` | `/api/projects/:p/log?ref=&limit=` | newest first |
| `GET` | `/api/projects/:p/diff?from=&to=` | intents + field-group changes |
| `POST` | `/api/projects/:p/merge` | `{ into, from, choices?, names? }` → up-to-date / fast-forward / merged; **409 + conflict list** until every conflict has a choice (send the same request again with `choices`) |
| `GET` | `/api/projects/:p/stats` | objects, bytes, branches |

Bad input gets a 400 with a message a person can act on (`clip p1: out must be after in`). Bodies over the limit get 413.

## Design choices

The full list, with the options we did not take and why, is in [DECISIONS.md](DECISIONS.md). The short version:

- **Whole frames, never float seconds.** A frame is the smallest real unit, and diff, merge and hashing need exact equality.
- **Every edit returns a new timeline.** Old versions stay valid, and unchanged clips are shared, which makes diff and storage cheap.
- **Edits refuse to create overlaps.** So every branch is clean, and any overlap in a merge is new.
- **Split keeps the id on the left part; the right part's id comes from the source frame of the cut.** Two editors making the same cut get the same id.
- **Stateless merge with stable conflict ids.** No "merge in progress" on the server; the client can change its mind.
- **Zero dependencies in the core.** The same code runs in Node and in the browser.

## Known limits

- **Criss-cross merges.** When there are two equally good common ancestors, git builds a virtual base; Branchcut takes the first one found.
- **Cross-track moves.** Ripples add up only on the same track. A clip moved to another track on one branch and rippled on the other is an edit-edit conflict.
- **Keyframes.** A property is one value. Animated properties would be stored as one value, so any two keyframe edits on the same property conflict.
- **Compare-and-set is single-process.** Refs are a JSON file behind an in-process queue. With many servers, refs move to a database and CAS becomes one statement: `UPDATE refs SET head = $next WHERE project = $p AND name = $b AND head = $expected` (0 rows → 409).
- **Ripples are inferred.** A hand move of exactly the same size as an edit on the same branch is counted as part of a ripple. In the diff that only changes a sentence. In the merge it matters once: if the other branch also moved that clip, the two shifts are added instead of becoming a conflict.
- **Tracks are not merged.** Track lists are taken from "ours"; adding or renaming tracks on both sides is not supported yet.
- **Whole-number fps.** 29.97 fps would need fps stored as a fraction.
- **Big edits copy the clip map.** A one-clip edit copies the clips object (about 29 ms at 20,000 clips). A persistent map (HAMT) would fix it.

## Why this matters for an agentic editor

Cardboard's Director can offer **3 variants** of a cut. Today each is a separate result, and picking one means losing the good parts of the others.

With Branchcut, **each variant is a branch**. The intent diff tells the user, and the agent, what each variant changed in editor words: *Ripple delete "Point 2"*, *Grade of "Intro": none → warm*. The user keeps the best parts of each by merging them. Most changes merge by themselves; the rest become one clear question the user or the agent can answer. And because the diff works from snapshots, it does not matter whether a person or the agent made the edit.

## Run it

Node 22.

```bash
npm install
npm test            # 54 unit + HTTP integration tests
npm run typecheck
npm run bench       # the table above (npm run bench -- 1000 for one size)
npm run build       # demo → docs/index.html (one file)
npm run demo        # build + serve it on http://localhost:5173
npm run test:e2e    # drives the built demo in your local Chrome/Edge
npm start           # API on http://localhost:8787, data in ./data
```

## Layout

```
src/core/     zero-dependency engine: timeline, ops, diff, intents, merge, sha256, repo
src/server/   node:http API, file storage, compare-and-set refs, input checks
src/demo/     the demo page (built into docs/index.html)
src/bench/    project generator + benchmark (also runs in the browser)
test/         unit and HTTP integration tests
e2e/          headless browser test of the demo
```
