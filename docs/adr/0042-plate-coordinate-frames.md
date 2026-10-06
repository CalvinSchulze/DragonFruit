---
kind: decision
date: 2026-10-06
---

# ADR-0042: Plate coordinate frames, and what Lychee does

**Status**: accepted

Context: multi-plate support (`src/features/scene/plates/`) had to settle three coordinate questions, and two of them stayed open through three implementation phases because the arguments were close:

1. Are model transforms stored in **world** space, with the plate offset baked in, or **plate-local**?
2. When a mesh (STL/3MF) is exported from a scene with several plates, are its coordinates world or plate-local?
3. How is "this model is on no plate" represented?

(1) was decided up front as world space, with plate-local transforms plus a `THREE.Group` per plate recorded as the rejected alternative. (2) was deferred. (3) was not asked until a user asked for it.

Lychee Slicer solves all three in shipping software, so rather than keep arguing from first principles we read what it does. The findings below are from its installed Electron bundle (`resources/app.asar` → `bin/render3D.js`, `bin/renderUI.js`, v2026.05). Identifiers are barely mangled. Reproduce by reading the asar header at byte 12 for the header length, parsing the JSON file table, and slicing `bin/render3D.js` out at its offset; then grep for the names quoted here. This is functional interoperability research — conventions and frames, not borrowed implementation.

## 1. Model transforms are world space. Lychee agrees.

```js
static ObjectWorldPosition(o) { return o.get("position"); }          // stored
static ObjectPlateLocalPosition(o) {                                  // derived
  return An.worldPositionToPlateLocalPosition(ObjectWorldPosition(o), ObjectPlateId(o));
}
static worldPositionToPlateLocalPosition(p, id) { return p.clone().sub(An.plateIdToPosition(id)); }
static plateLocalPositionToWorldPosition(p, id) { return p.clone().add(An.plateIdToPosition(id)); }
```

`position` is the stored field and it is world. Plate-local is a selector that subtracts a position derived from the plate's index — our `derivePlateOffset` and the D4 subtraction, arrived at independently. Writes go the other way through `plateLocalPositionToWorldPosition` before being stored, so plate-local is the *input* frame, never the persisted one.

This also matches the `.lys` files we import: the scene payload is a flat `objects.present.byId` map with no plate grouping, and a project that spanned several Lychee plates arrives with its objects at raw world coordinates hundreds of mm apart. That is the read side of the same decision.

Decision: **keep D1 unchanged.** The deciding argument for this codebase was never elegance — it is that supports are a separate state tree keyed by `modelId` storing absolute `Vec3` (59 files under `src/supports/` touch those coordinates) and deliberately carry no `plateId`. Plate-local models with world-space supports means two frames to reconcile at every interaction point; converting both means a frame change across placement raycasting, pathfinding, autoSupport and island analysis. Lychee's independent agreement is corroboration, not the reason.

Note also that plate-local storage needs *two* frames — plate-relative on a plate, world off one — where world storage needs one, and plate-local is always a single subtraction away as a derived value.

## 2. Mesh export is world space, including the plate offset

The export path hands the whole object container to the writer with an id scope, and the collector takes world matrices:

```js
// q7 — collect exportable meshes
t.push({ geometry: h, matrix: l.matrixWorld, shouldCreateNormal: ... });

// e7.parse — binary STL writer; `t` is asOriginalMesh
d.set(S[0], S[1], S[2]);
t || d.applyMatrix4(q.matrix);
```

`matrix` is `matrixWorld`, and models are not parented to per-plate groups — `plateGroup` holds the plate *visuals* (`PlatesContainer.addPlate`), not objects. So a model on plate 3 exports at its plate-3 world coordinates. There is no plate-local re-centring anywhere in the path.

What Lychee offers instead, for users who do not want scene placement baked into the file, is a **second export mode**: "Export as original mesh" (`exportSelected(supportsMode, asOriginalMesh)`, Ctrl+Alt+E) skips `applyMatrix4` entirely and writes the raw source geometry with supports hidden.

Decision: **mesh export stays world space** — which is what `ExportManager.exportScene` already does, so this closes the question with no code change. The reasonable future addition is original-mesh export, not plate-local export: "give me the model without where it happens to be sitting" is better served by dropping the transform than by subtracting one plate offset from it.

## 3. Off-plate is a sentinel `plateId`, not a hidden plate

Lychee keeps the invariant that every object's `plateId` resolves to a real plate record, and represents "not on a plate you can see" with a plate flagged `isVirtual`:

```js
plate = { id, visible, name, size: {x,y,z}, isVirtual: false, index, position: {x,y,z} }

static PlateIsVirtual(p) { return p.get("isVirtual"); }
static PlateNonVirtualIds(s) { /* allIds.filter(not virtual) */ }

static getOutOfPlatedObjectIds() {
  // for each object: virtual plates are exempt; otherwise flag when the
  // recorded plateId disagrees with worldPositionToExactNoVirtualPlateId(...)
}
```

Virtual plates are filtered out of plate listings and exempt from the out-of-plate check. Their plate record is otherwise ordinary, including a real `position`.

Decision: **use an explicit `OFF_PLATE_ID` sentinel** (`src/features/scene/plates/types.ts`) rather than a virtual plate.

Lychee's approach is genuinely cleaner in one way — no magic string, no "unknown id" repair path, and `plateIdToPosition` works uniformly. Three things decided it the other way here:

- A virtual plate *has* a position, so objects on it are plate-local to something. The requirement was a model staged in world space on no plate at all; the sentinel resolves to an offset of `{0, 0}`, which is world space exactly.
- Lychee pays for it by threading `PlateNonVirtualIds` through many selectors: every site that counts, lists or validates plates must remember to filter. That cost is diffuse and one missed call site is a silent bug. The sentinel confines its special case to two places — the load-time repair in `plateNormalisation.ts` and the offset fallback — both tested.
- `isVirtual` would have to be persisted, widening `VoxlPlateEntry`. An older build would then read a virtual plate as a mysterious extra *real* plate, where it reads the sentinel as a dangling id and repairs the model onto plate 1 — the better degradation.

The sentinel's own trap is recorded in the VOXL spec and worth repeating: it must be a **non-empty, non-uuid string**, never `null`. Both writers emit `plateId` behind `...(plateId ? { plateId } : {})` and the reader repairs with the same truthiness test, so a falsy marker is dropped on save and then reassigned onto plate 1 on load — the model silently hops onto a plate. `undefined` is equally unusable: it already means *unstamped*, the legacy case that must resolve to a real plate.

## Where we deliberately differ

- **Membership test.** Lychee tests `Box3(platePosition ± buildVolume/2).containsPoint(objectWorldPosition)` — a point test on the object's origin, returning null for no plate — and `worldPositionToPlateIndex` otherwise picks the *nearest* plate by squared distance. We test plan-view bounds *overlap* (`classifyModelPlate`), which is more forgiving: a large model whose origin has drifted past the plate edge still belongs to that plate. Z is ignored in both, so a lifted model keeps its plate.
- **Mismatch handling.** Lychee *flags* out-of-plate objects and never moves them between plates on its own. We re-derive membership on a committed transform, so dragging a model clear of every plate stages it and dragging it back re-adopts it. That was an explicit product choice; surfacing an out-of-plate warning on top of it remains worthwhile.
- **Layout.** Lychee lays plates out as a 2D grid with `GAP_X = 50`, `GAP_Y = 60`. We use a single row along +X with `PLATE_GAP_MM = 20` and no reordering, both deliberate for v1 — a grid changes `derivePlateOffset` only, since `slotIndex` is already an opaque lattice slot.

## Related

- [VOXL format spec — build plates](../dev/voxl-format-spec.md)
- [Slice job assembly — one plate per job](../dev/slice-job-assembly.md)
- [ADR-0034: VOXL binary container format](0034-voxl-binary-container-format.md)
