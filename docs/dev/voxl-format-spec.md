# VOXL Format Spec

VOXL is DragonFruit’s native scene container. This page captures the core contract engineers should rely on in code and tests.

## Supported generations

| Generation | Container                                                | Status                       |
| ---------- | -------------------------------------------------------- | ---------------------------- |
| V1         | UTF-8 JSON (direct document or compressed JSON envelope) | Legacy read support required |
| V2.0       | Binary chunk container                                   | Historical                   |
| V2.1       | Binary chunk container                                   | Superseded by V2.2           |
| V2.2       | Binary chunk container                                   | Superseded by V2.3           |
| V2.3       | Binary chunk container                                   | Superseded by V2.4           |
| V2.4       | Binary chunk container                                   | Current read/write target    |

Readers must support V1 and V2.x. Writers should emit V2.4 semantics.

## Core conventions

- Extension: `.voxl`
- Media type: `application/vnd.dragonfruit.voxl`
- Units: millimeters (`mm`)
- Coordinate basis: right-handed, Z-up
- Rotation storage: Euler radians (XYZ)

Format detection by first bytes:

- `{` (`0x7B`) → V1 JSON
- `VOXL` (`0x56 0x4F 0x58 0x4C`) → V2 binary

All transform/vector numbers must be finite IEEE 754 values.

## V1 contract (JSON)

Top-level profiles:

1. direct scene JSON document
2. compressed envelope containing scene JSON

Required root fields (direct profile):

- `magic = "VOXL"`
- `version = 1`
- `meta`
- `scene`
- `models`
- `supports`

Optional root fields:

- `extensions`

V1 mesh object supports:

- `none`
- `external-file`
- `embedded-file`

Supported V1 mesh encodings:

- `base64-raw`
- `base64-rle-u8`

For `base64-rle-u8`, decoded size must equal `uncompressedSizeBytes`.

Compressed envelope profile fields:

- `compression.kind = "document-json-utf8"`
- `compression.encoding`: `base64-raw`, `base64-rle-u8` or `base64-zlib`
- `compression.uncompressedSizeBytes`
- `compression.payloadBase64`

## V2 contract (binary chunks)

V2 layout:

- 16-byte file header
- chunk directory (`chunkCount` entries, 20 bytes each)
- chunk payload region

Header requirements:

- `magic = VOXL`
- `version = 2` (container-major; V2.0, V2.1, and V2.2 all use this — semantic revisions do not bump the header.)
- little-endian integer fields

Compression codes:

| Code | Meaning |
| ---- | ------- |
| `0`  | none    |
| `1`  | zlib    |

Unknown compression codes must fail parsing.

Chunk types:

| Type   | Expected use        |
| ------ | ------------------- |
| `META` | scene metadata JSON |
| `SCNE` | scene state JSON    |
| `MODL` | models JSON         |
| `MESH` | raw mesh bytes      |
| `SUPP` | supports JSON       |
| `EXTD` | extensions JSON     |
| `HSRC` | hollowing source-mesh positions — V2.2   |
| `CAVT` | hollowing cavity-mesh positions — V2.2   |
| `PSRC` | hole-punch source-mesh positions — V2.2  |

Unknown chunk types may be ignored.

For embedded model meshes, `MODL[i]` maps to `MESH(index = i)`.

### V2.1 semantic revision

V2.1 is a semantic revision of the V2 binary container; it does **not** change the binary header major version.

V2.1 additionally requires:

- `MODL[*].meshModifiers` persistence for model modifier state.
- Hollowing source snapshot persistence in the hollowing modifier payload:
	- `sourcePositionsBase64`
	- `sourcePositionCount`
- `bakedIntoGeometry` semantics for modifiers that are already baked into mesh geometry.

Behavioral requirement:

- Hollowing re-apply must use persisted source snapshot geometry.
- Implementations must **not** fall back to re-hollowing the already-baked mesh when the snapshot is missing.

This is required so hollowing and hole-punch workflows remain re-editable after VOXL round-trips.

### V2.2 semantic revision

V2.2 is a semantic revision of the V2 binary container; like V2.1 it does **not** change the
binary header major version (`version` stays `2`, or `3` when identical-geometry dedup also
fired — the two are orthogonal).

V2.2 moves the large modifier position snapshots **out of the `MODL` JSON and into raw-binary
chunks**, indexed by model index like `MESH`:

| Modifier field (in-memory / V2.1 JSON) | V2.2 chunk | Dedup pointer (MODL JSON)          |
| -------------------------------------- | ---------- | --------------------------------- |
| `hollowing.sourcePositionsBase64`      | `HSRC`     | `hollowing.sourceChunkIndex`      |
| `hollowing.cavityPositionsBase64`      | `CAVT`     | `hollowing.cavityChunkIndex`      |
| `holePunchSourcePositionsBase64`       | `PSRC`     | `holePunchSourceChunkIndex`       |

Rationale: these snapshots are non-indexed `Float32` triangle-soup meshes (often larger than
the model's own geometry). Concatenated as base64 inside one `MODL` JSON string, several such
models exceed V8's ~512 MiB single-string ceiling, so `JSON.stringify(models)` (and, on read,
`JSON.parse`) throws `RangeError: Invalid string length`. Chunking the raw bytes removes the
ceiling on both sides and drops the 4/3 base64 inflation.

Requirements:

- Writers store the **raw `Float32` bytes** in `HSRC`/`CAVT`/`PSRC` (not base64), `zlib`
  compressed, at the owning model's index.
- The `*PositionCount` fields (`sourcePositionCount`, `cavityPositionCount`,
  `holePunchSourcePositionCount`) and `enabled` / `bakedIntoGeometry` flags **remain in the
  `MODL` JSON**; the matching `*Base64` fields are omitted.
- These chunks are **content-deduplicated within each type**, mirroring `MESH` dedup:
  identical snapshots across models share one chunk. The first occurrence owns it (chunk
  `index` = owner model index); later identical ones write no chunk and instead carry a
  `*ChunkIndex` pointer (see table) in the MODL JSON naming the owner. Dedup is keyed by the
  blob's own content, **independent of `MESH` dedup** — a MESH-duplicate model may still own
  its own `HSRC`/`CAVT`/`PSRC` chunk, and two models sharing `MESH` geometry may still hold
  distinct modifier snapshots. Deduping these chunks does not bump the header (unlike MESH
  dedup, which bumps to `3`): they are invisible to older readers.

Detection (no version number is written for the semantic revision): a `MODL` entry whose
`meshModifiers` carries a non-zero `*PositionCount` with the matching `*Base64` **absent**
means the data lives in the corresponding `HSRC`/`CAVT`/`PSRC` chunk, read at
`index = *ChunkIndex ?? modelIndex` (owner defaults to its own model index; a duplicate's
`*ChunkIndex` names the owner).

Backward compatibility (accepted tradeoff): because the header does not bump and unknown chunk
types may be ignored, older V2/V2.1 readers still open a V2.2 file — baked geometry loads from
`MESH`, and they silently drop only the hollow/hole re-editability snapshots.

### V2.3 semantic revision

V2.3 is a semantic revision of the V2 binary container; like V2.1 and V2.2 it does **not** change
the binary header major version (`version` stays `2`, or `3` when identical-geometry dedup also
fired).

V2.3 adds an optional `typeId` to every entity in the supports payload, recording the support
type explicitly rather than leaving it implicit in the array the entity sits in.

Requirements:

- Writers stamp `typeId` on every entity they write.
- Readers must accept a payload without it, deriving each entity's type from the array it
  appears in. `typeId` is never required to interpret a file.

Detection (no version number is written for the semantic revision): an entity carrying `typeId`
is V2.3; a payload without it is read exactly as before. The revision is additive, so the
semantic revision a reader reports for a V2 file stays `2.2`, or `2.1` when the file carries
inline modifier snapshots; `typeId` is not part of that detection.

Backward compatibility: the field is optional and unknown JSON keys are ignored, so a V2.3 file
opens in a V2/V2.1/V2.2 reader with no loss beyond the explicit type stamp.

### V2.4 semantic revision (current)

V2.4 is a semantic revision of the V2 binary container; like V2.1–V2.3 it does **not** change the
binary header major version (`version` stays `2`, or `3` when identical-geometry dedup also
fired).

V2.4 adds an optional `classification` to a `MODL` entry: the native model/support classification
that ran over the triangle order of that model's `mesh` payload. The value is the classifier's
report — the `MeshHealthReport` shape (`src/utils/meshRepair.ts`), whose `model_triangle_count`
is the split boundary: the first N triangles are the model body, the remainder support geometry.

Requirements:

- Writers stamp `classification` only when the classifier actually ran over the exact payload
  being written. A geometry replaced after classification (a baked hollowing, hole punch, mirror,
  or repair) carries none — the boundary would not address it — and neither does a payload whose
  bake fell behind the live geometry.
- The boundary is expressed in the triangle order of the **stored mesh bytes**, not of the
  original import. Native decimation preserves section order, so a reduced preview's boundary is
  the one the reader must use.
- Readers that honour it must not re-run the classifier: the report is the answer for exactly
  these triangles. They must still build the model/support section split from
  `model_triangle_count`, since the sections are not stored separately.
- Readers must accept a `MODL` entry without it and classify as before. `classification` is never
  required to interpret a file, and an auto-repair pass on load supersedes it.

Detection (no version number is written for the semantic revision): a `MODL` entry carrying
`classification` is V2.4. As with V2.3 it does not participate in the reported semantic
revision, which stays `2.2` or `2.1`.

Backward compatibility: the field is optional and unknown JSON keys are ignored, so a V2.4 file
opens in an older V2 reader with no loss beyond the classifier having to run again.

### Build plates (V2.5 semantic revision)

Like V2.1–V2.4 this is a semantic revision only: the binary header major version is **deliberately
unchanged** (`version` stays `2`, or `3` when identical-geometry dedup also fired). The chunk
layout is untouched — plates are additive JSON fields inside `SCNE` and `MODL`.

A project owns N build plates; exactly one is active. Only the active plate's models are
selectable, transformable, sliceable and mesh-exportable, but the `.voxl` persists **every** plate.

`SCNE` gains two optional fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `plates` | `VoxlPlateEntry[]` | Every build plate in the project. |
| `activePlateId` | `string \| null` | Id of the active plate. |

```jsonc
{
  "activeModelId": "model-1",
  "selectedModelIds": [],
  "plates": [
    { "id": "plate-a", "name": "Plate 1", "slotIndex": 0, "offsetMm": { "x": 0,   "y": 0 } },
    { "id": "plate-b", "name": "Minis",   "slotIndex": 1, "offsetMm": { "x": 170, "y": 0 } }
  ],
  "activePlateId": "plate-b"
}
```

`MODL` entries gain an optional `plateId` naming the owning plate.

**Geometry is world-space.** A model's `transform.position` already includes its plate's offset —
plates are a layout property, not a parent transform. A multi-plate file therefore opens in a
build without plate support as a geometrically *valid* scene whose models are simply spread
across a wide area, rather than a pile of overlapping models.

**`slotIndex` and `offsetMm`.** Plates occupy a single row along +X, where
`offsetX = slotIndex * (buildVolumeWidthMm + 20)` and `offsetY = 0`. `slotIndex` is permanent:
deleting a plate frees its slot and a new plate takes the lowest free one, so plates are never
repacked by ordinary editing. `offsetMm` is stored redundantly on purpose — it records the offset
that was **in effect when the member transforms were written**. On load, a reader compares it
against the offset derived from its own build volume; a mismatch means the file was saved under a
different printer profile, and the member models and their supports are translated by the delta
(`repackPlates`, `src/features/scene/plates/repackPlates.ts`). Readers must therefore **not**
recompute `offsetMm` on read — doing so destroys exactly the signal that comparison needs.

**Supports carry no plate.** A support's plate is implied by its model via the `modelId` every
support primitive already has. `plateId` must never be written onto a support; it would drift.

Legacy rule — **one implicit plate**. `plates` is absent in every file written before this
revision. Readers (`parseVoxlBinaryV2`, `parseVoxlDocument`) normalise on load via
`src/features/scene/voxl/plateNormalisation.ts`, guaranteeing four invariants to everything
downstream:

- at least one plate exists — when `plates` is absent or empty, one is synthesised at
  `slotIndex: 0` with `offsetMm: {x: 0, y: 0}`;
- `activePlateId` resolves to an existing plate, falling back to the first;
- every model's `plateId` resolves to an existing plate — a missing or dangling id is reassigned
  to the first plate, so **a file never loads with orphaned models**;
- `slotIndex` is unique, and a non-finite `slotIndex` or offset component is repaired.

Writers omit both fields entirely when the caller supplies no plate state, so a project that never
saw plates serializes to exactly the bytes it did before. Backward compatibility is therefore
two-way: an older reader ignores the unknown keys and sees a normal scene, and a newer reader
opens an older file as a single-plate project.

Scoped exports (the export panel's per-model and subset writes) deliberately pass no plates: an
exported subset is a one-plate document, not a copy of the project's layout.

## Supports and extensions

Supports payloads are DragonFruitImportFormat-compatible. Common arrays include:

- `roots`, `trunks`, `branches`, `leaves`, `braces`, `knots`

Optional arrays:

- `twigs`, `sticks`, `stumps`, `kickstands`

Every entity may carry an optional `typeId` naming its support type (V2.3). A payload without
it is read exactly as before, with each entity's type derived from the array it appears in.

Extensions location:

- V1: root `extensions`
- V2: `EXTD` chunk

Unknown extension keys should be ignored.

## Implementation notes

- Export writes V2 by default. Mesh bytes go raw into `MESH` chunks with per-chunk zlib, with no base64, which makes files roughly 60-65% smaller than V1 for typical scenes and faster to write and read.
- The V2 reader hands callers pre-decoded mesh bytes through `ParsedVoxlResult.meshBytes`.
- The V1 import path is fully preserved: base64 decoding, RLE and SHA-256 validation.

## Validation expectations

Readers should enforce:

1. valid JSON payload parse
2. required field presence
3. finite numeric transform values
4. V2 chunk bounds correctness
5. compression/decompression validity
6. decoded-size checks
7. optional SHA-256 verification when digest fields are present

## Related files

- `src/supports/types.ts`
- `src/features/scene/voxl/types.ts`
- `src/hooks/useStlGeometry.ts`
- `docs/dev/formats.md`
