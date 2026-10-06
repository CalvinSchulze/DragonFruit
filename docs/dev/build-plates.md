# Build Plates

A project owns N **build plates**. All of them render; exactly one is
**active**. Only the active plate's models can be selected, transformed,
supported, arranged, sliced or exported — inactive plates draw dimmed and
inert. Think Lychee's plate tabs.

Reach for this page when you are touching anything that asks "which models?":
scene state, selection, slicing input, project persistence, or the viewport.
The coordinate-frame decisions and the alternatives that were rejected live in
[ADR-0042](../adr/0042-plate-coordinate-frames.md); this page is the interface.

## The three rules that make everything else follow

1. **A model's `transform` is world space**, and already includes its plate's
   offset. Plate offset is a *layout* property, not a parent transform. So
   rendering, picking, gizmos, supports, arrange, bounds and camera all keep
   the maths they had before plates existed.
2. **A support's plate is implied by its model.** Supports carry `modelId` and
   never `plateId`, so grouping them by plate is free and the support subsystem
   needs no plate awareness at all.
3. **Plate-local coordinates exist in exactly one place**: the triangle
   collector that feeds the slicer. Subtracting the offset anywhere else
   double-offsets, which looks almost right and is painful to find.

## The data model

`src/features/scene/plates/types.ts`:

```ts
type Plate = {
  id: string;          // uuid, stable identity, never reused
  name: string;        // user-editable; "Plate 1", "Plate 2", … by default
  slotIndex: number;   // permanent lattice slot, assigned at creation
  offsetMm: { x: number; y: number };  // the offset the member transforms were written against
};
```

Plates lay out as a single row along +X:
`offsetX = slotIndex * (buildVolumeWidthMm + PLATE_GAP_MM)`, `offsetY = 0`.

`slotIndex` is permanent, and deleting a plate frees its slot for the next one
to reclaim. That is what guarantees plates are **never repacked on add or
delete**, so ordinary editing never rewrites a model transform. There is no
plate reordering, deliberately — it would.

`offsetMm` is stored redundantly on purpose. It records the offset that was in
effect when the member transforms were written, so `derivedOffset !== offsetMm`
means the build volume changed — a profile switch, or a file saved on a machine
with a different printer — and the plates need a repack.

`OFF_PLATE_ID` is the `plateId` of a model deliberately on no plate at all,
staged somewhere in world space. It is a non-empty, non-uuid **string**, and it
has to stay that way: both VOXL writers emit `plateId` behind a truthiness
guard, so a falsy sentinel would be dropped on save, and `undefined` already
means *unstamped* (the legacy-file case that must resolve to a real plate). An
off-plate model is persisted, rendered, selectable and keeps its supports, but
is never sliced or mesh-exported.

## Public surface

### `src/features/scene/plates/` — pure, no React, no three.js state

| Module | Exports | For |
| --- | --- | --- |
| `types.ts` | `Plate`, `PlateOffsetMm`, `PlateBuildVolume`, `PlateFootprintRect`, `PLATE_GAP_MM`, `MAX_PLATES`, `OFF_PLATE_ID`, `isOffPlate` | the data model |
| `plateLayout.ts` | `derivePlateOffset`, `lowestFreeSlotIndex`, `defaultPlateName`, `createPlate`, `plateOffsetsEqual`, `platesNeedRepack`, `plateFootprintRect`, `resolveModelPlateId`, `classifyModelPlate`, `selectInteractiveModels` | layout and membership |
| `plateOperations.ts` | `sortPlatesBySlot`, `canAddPlate`, `addPlateToSet`, `removePlateFromSet`, `renamePlateInSet`, `duplicatePlateName`, `plateOffsetDelta`, `countModelsByPlate` | plate-set arithmetic |
| `assignModelPlates.ts` | `assignModelPlates`, `modelFootprintRect` | deriving membership from geometry |
| `repackPlates.ts` | `repackPlates` | the build-volume migration |

Everything is re-exported from `src/features/scene/plates` — import from the
directory, not the file.

Two reads you should never open-code:

- **`resolveModelPlateId(model, activePlateId)`** — a model without an explicit
  `plateId` is a legacy or pre-plates model and resolves to the active plate,
  so it can never be orphaned. `OFF_PLATE_ID` passes through unchanged.
- **`selectInteractiveModels(allModels, activePlateId)`** — what the user can
  act on: the active plate's models **plus** the off-plate ones. Models on
  other plates are excluded; off-plate models are included because there is no
  plate to switch to, and dragging one back is the only way to recover it. The
  viewport and the model list share this function precisely so they cannot
  drift into disagreeing about what is selectable. It is *not* the slicing or
  export set — those follow the active plate alone.

### `useSceneCollectionManager` — the state and the operations

Plate state lives in the scene hook (`src/features/scene/useSceneCollectionManager.ts`),
which exposes:

| Name | Meaning |
| --- | --- |
| `models` | **the active plate's models.** What every editing, selection, slicing and export consumer wants |
| `allModels` | every model in the project. Project save, autosave, multi-plate rendering, duplicate-name generation, scene-wide emptiness checks — and nothing else |
| `interactiveModels` | `selectInteractiveModels(allModels, activePlateId)` |
| `offPlateModels` | the staged ones |
| `plates`, `activePlateId` | the plate set and which one is active |
| `activePlateOffsetMm` | the active plate's **recorded** offset — for the slicer and for plate-relative bounds |
| `plateModelCounts` | `{ byPlateId, offPlate }`, for the tab strip |
| `canAddPlate` | false at `MAX_PLATES` |
| `setActivePlate(id)` | switch plates |
| `addPlate()` | new empty plate at the lowest free slot; returns its id, or `null` at the cap |
| `renamePlate(id, name)` | blank names fall back to the slot default |
| `deletePlate(id)` | async; deletes the plate and its models |
| `duplicatePlate(id)` | copies the plate, its models and their supports onto a new plate |
| `setModelsOffPlate(ids)` | records the off-plate decision; does not move anything |

`models` being the filtered list is the load-bearing trick: every existing call
site that reads `scene.models` scopes to the active plate with no edit.

### Writing models

Do **not** rewrite the `setModels` call sites to operate on filtered models.
They own the full backing array and resolve models by `id`. `setModels` is a
reducer that funnels every write through `assignModelPlates`, which stamps
`plateId` onto anything arriving without one and re-derives membership for any
model whose transform changed — so a fresh import lands on the plate its
geometry overlaps, a drag clear of every plate stages the model, and a drag
back onto one re-adopts it. Paste, duplicate and import therefore target the
active plate automatically; do not add per-site stamping on top.

## Using it

Reading the active plate needs nothing special:

```tsx
// Already scoped to the active plate.
const visible = scene.models.filter((model) => model.visible);
```

Adding a plate operation to a toolbar:

```tsx
<button type="button" disabled={!scene.canAddPlate} onClick={scene.addPlate}>
  <Trans>Add plate</Trans>
</button>
```

Answering "which plate does this geometry sit on?" outside React:

```ts
import { classifyModelPlate, modelFootprintRect, isOffPlate } from '@/features/scene/plates';

const plateId = classifyModelPlate(
  modelFootprintRect(model),
  plates,
  { widthMm, depthMm, originMode },
  activePlateId,            // keeps the model where it already is, on a tie
);
if (isOffPlate(plateId)) { /* staged on no plate */ }
```

Membership is a plan-view **overlap** test, not containment, and Z is ignored:
a model straddling a plate edge is out of bounds *on that plate* rather than
homeless, and a model lifted high above its plate still belongs to it.

## Constraints and invariants

Asserted in dev builds inside `useSceneCollectionManager`:

1. `plates.length >= 1` — always. `removePlateFromSet` refuses the last plate.
2. `plates.length <= MAX_PLATES` for plates this app creates. The VOXL reader
   never drops plates, so a file may legitimately carry more.
3. `activePlateId` always resolves to an existing plate.
4. `slotIndex` is unique across plates.
5. Every model resolves to an existing plate, or is explicitly off-plate.
6. A support never carries `plateId`.
7. A model's `transform` is world space, plate offset included.
8. Plate offsets change **only** via `repackPlates`.

And three rules that are not expressible as assertions:

- **Never allocate per-plate build-volume geometry.** It is identical for every
  plate — build it once and render N meshes at different positions.
- **Mesh modifiers are not on the model object.** They live in
  `src/features/mesh-modifiers/meshModifierStore.ts`, keyed by model id, so
  spreading a model does not carry them. `duplicatePlate` copies them
  explicitly; anything else that clones models across plates must too.
- **Group and link ids are remapped, not shared, when a plate is duplicated.**
  A shared `linkGroupId` would make a transform on one plate drag models on
  the other.

## The repack

`repackPlates(plates, models, buildVolume, activePlateId)` translates every
model — and its supports, via `transformSupportsForModel` — belonging to a
plate whose derived offset no longer matches its recorded `offsetMm`, then
records the new offsets. It runs in two places:

- the scene loader, when a `.voxl` was saved against a different build volume;
- an effect in the scene hook keyed on the build-volume width, when the user
  switches printer profile.

It is a **consistency migration, not a user edit**: callers must not push it
onto the history stack. Off-plate models are never moved — they are staged in
world space and belong to no plate, so no plate's offset change applies.

Slot 0 is always the world origin, so a single-plate project never repacks.

## History

One stack, plate-aware snapshots. `SceneSnapshot` carries `plates` and
`activePlateId`, and `applySceneSnapshot` restores plates **before** models so
the stamping reducer sees the snapshot's active plate. Undo across a plate
switch is expected: stepping back onto an edit made elsewhere takes you to
where it happened.

Which plate operations are undoable, and why:

| Operation | History | Why |
| --- | --- | --- |
| `addPlate`, `renamePlate`, `deletePlate`, `duplicatePlate` | one atomic entry each | they change what the project contains |
| `setActivePlate` | none | it changes what you are looking at, like selecting a model |
| the repack | none | a migration, not an edit |

Two traps when pushing plate history:

- Pass `platesOverride` / `activePlateIdOverride` to `captureSceneSnapshot`
  when you have already computed the next plate state. The module-level plate
  mirror still holds the *pre-update* value when you capture the `after`
  snapshot synchronously, so without the overrides the snapshot records stale
  plates — exactly how `supportStateOverride` handles the same staleness.
- `deleteModels(ids, { recordHistory: false })` returns the resulting
  `{ models, activeModelId, selectedModelIds }` instead of pushing. That is how
  `deletePlate` gets the plate and its models
  onto one undo while still going out through the one code path that cleans up
  supports, mesh chunks and the modifier store. Never splice the models array
  directly.

## Slicing and export

Only the active plate is sliced, and only `.voxl` persists every plate.

| Path | Scope |
| --- | --- |
| Slice / raster export | active plate, plate-local coordinates |
| STL, 3MF | active plate, **world** coordinates (see ADR-0042 §2) |
| `.voxl` | every plate |

The plate-local conversion is one subtraction inside `TriangleFloatCollector`
(`src/features/slicing/rasterLayerZipExport.ts`): its constructor takes an
`originOffset`, and `pushTriangle` subtracts it from the X and Y of all three
vertices. Z is untouched — plates share the Z=0 floor. Because models,
supports, rafts and kickstands all flow through that one collector, they become
plate-local together. Callers thread the offset in as `plateOffsetMm` on
`SliceExportOrchestratorOptions`, and it defaults to `{x: 0, y: 0}`, so a
single-plate scene slices byte-identically to a pre-plates build.

## Persistence

`VoxlSceneState` gained `plates?: VoxlPlateEntry[]` and `activePlateId?`, and
`VoxlModelEntry` gained `plateId?`. The container version is deliberately
**unchanged**: the scene chunk is read as additive JSON, so a plate-bearing
file stays readable by current builds.

On read, `normaliseVoxlPlates` and `reassignOrphanedModelPlates`
(`src/features/scene/voxl/plateNormalisation.ts`) guarantee at least one plate,
an `activePlateId` that resolves, and no orphaned models — a file with no
`plates` loads into one implicit plate at slot 0. Full details in the
[VOXL format spec](voxl-format-spec.md).

Both writers need the plate fields: `serializeVoxlDocumentV2` **and**
`serializeVoxlDocumentV2Streaming`, which `ExportManager` uses for large
scenes. Miss the streaming one and plates vanish silently on big projects.

## Rendering

`SceneCanvas` takes `plates` and `activePlateId` props and falls back to a
single plate on the world origin when they are absent, which is what every
pre-plates caller already meant. Inside it:

- one shared build-volume geometry, rendered once per plate at its offset;
- `Helpers` (`src/components/scene/SceneCanvas/SceneEnvironment.tsx`) draws the
  plate slab, grid and front label per plate, positioned by `originMinX` /
  `originMinY`; only the active plate carries the logo decal;
- inactive-plate models render dimmed, non-raycastable and excluded from hover
  and selection tinting;
- each **inactive** plate carries an invisible hit plane over its footprint, so
  clicking a plate in the viewport activates it (`onActivatePlate`). Only
  inactive plates get one — the active plate's surface has to stay clear for
  support placement, marquee and the pointer-miss deselect. The plane is
  `transparent opacity={0}` rather than `visible={false}`, because three's
  raycaster skips invisible objects and an invisible mesh is an unclickable
  one;
- the camera orbits the **active** plate's centre, and a plate switch pans the
  camera and its orbit target by the offset delta so the user's angle and zoom
  survive the switch.

Remember the export-thumbnail path
(`src/components/scene/SceneCanvas/useExportThumbnailCapture.ts`) — it renders
the scene and must frame the active plate only.

## UI

`src/components/layout/PlateTabStrip.tsx` is the plate tab strip, rendered
bottom-centre of the viewport by the editor shell. One tab per plate with its
model count, ordered by `slotIndex` so a reclaimed slot puts a plate back where
the deleted one was. `+` adds; double-click or the context menu renames;
duplicate and delete are context-menu only, so they cannot be hit while
clicking between plates.

The strip carries `data-editor-context-menu="skip"`. The editor's own
right-click menu opens from capture-phase pointer handlers on `#scene-root`,
one of which calls `stopPropagation`, so any nested surface that owns a context
menu has to opt out there or its menu never opens and the editor's opens on top
of it. `ownsItsContextMenu` in `src/app/page.tsx` is the guard.

Interpolating strings go through
`src/components/layout/plateTabMessages.ts` — module scope, per the
[localization](localization.md) rule.

Plate state is part of the project, not a preference: nothing about plates is
written to `localStorage`.

## Out of scope

Slicing or exporting several plates in one job; per-plate printer or material
profiles; plate reordering; cross-plate drag-and-drop; per-plate camera memory.

## Related

- [ADR-0042: Plate coordinate frames, and what Lychee does](../adr/0042-plate-coordinate-frames.md)
- [VOXL Format Spec](voxl-format-spec.md)
- [Slice Job Assembly](slice-job-assembly.md)
- [History and Undo/Redo](history-and-undo-redo.md)
- [State and Stores](state-and-stores.md)
- [Camera Navigation](camera-navigation.md)
- [Localization](localization.md)
