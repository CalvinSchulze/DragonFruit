import assert from 'node:assert/strict';
import test from 'node:test';

import { parseVoxlBinaryV2, serializeVoxlDocumentV2 } from '../codec-v2';
import { buildVoxlDocumentV1, parseVoxlDocument, serializeVoxlDocument } from '../codec';
import { normaliseVoxlPlates, reassignOrphanedModelPlates } from '../plateNormalisation';
import { OFF_PLATE_ID } from '@/features/scene/plates';
import type {
  BuildVoxlDocumentInput,
  VoxlModelEntry,
  VoxlModelRuntimeLike,
  VoxlPlateEntry,
  VoxlSceneState,
} from '../types';
import type { DragonfruitImportFormat } from '@/supports/types';

const EMPTY_SUPPORTS: DragonfruitImportFormat = {
  version: 1,
  meta: { source: 'unit-test', objectCenter: { x: 0, y: 0, z: 0 } },
  roots: [],
} as unknown as DragonfruitImportFormat;

function model(id: string, plateId?: string, x = 0): VoxlModelRuntimeLike {
  return {
    id,
    name: id,
    visible: true,
    color: '#ffffff',
    polygonCount: 1,
    ...(plateId ? { plateId } : {}),
    transform: {
      position: { x, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
    mesh: { mode: 'embedded-file', fileName: `${id}.stl`, mimeType: 'model/stl' },
  };
}

const PLATE_A: VoxlPlateEntry = { id: 'plate-a', name: 'Plate 1', slotIndex: 0, offsetMm: { x: 0, y: 0 } };
const PLATE_B: VoxlPlateEntry = { id: 'plate-b', name: 'Minis', slotIndex: 1, offsetMm: { x: 170, y: 0 } };

function input(overrides?: Partial<BuildVoxlDocumentInput>): BuildVoxlDocumentInput {
  return {
    models: [model('m1', PLATE_A.id), model('m2', PLATE_B.id, 170)],
    activeModelId: 'm1',
    selectedModelIds: [],
    supports: EMPTY_SUPPORTS,
    plates: [PLATE_A, PLATE_B],
    activePlateId: PLATE_B.id,
    ...overrides,
  };
}

const MESH = new Uint8Array([1, 2, 3, 4]);

function meshMap(count: number): Map<number, Uint8Array> {
  const out = new Map<number, Uint8Array>();
  for (let i = 0; i < count; i += 1) out.set(i, MESH);
  return out;
}

// ── V2 binary roundtrip ───────────────────────────────────────────────────

test('V2 roundtrip preserves plates, active plate and per-model plateId', async () => {
  const bytes = await serializeVoxlDocumentV2(input(), meshMap(2));
  const { document } = parseVoxlBinaryV2(bytes);

  assert.deepEqual(document.scene.plates, [PLATE_A, PLATE_B]);
  assert.equal(document.scene.activePlateId, PLATE_B.id);
  assert.equal(document.models[0].plateId, PLATE_A.id);
  assert.equal(document.models[1].plateId, PLATE_B.id);
});

test('V2 roundtrip preserves offsetMm exactly, so repack detection still works', async () => {
  const bytes = await serializeVoxlDocumentV2(input(), meshMap(2));
  const { document } = parseVoxlBinaryV2(bytes);

  // offsetMm records the offset in effect when the transforms were written.
  // Rewriting it on read would destroy the signal repackPlates depends on.
  assert.deepEqual(document.scene.plates?.[1].offsetMm, { x: 170, y: 0 });
});

test('V2 writer omits plate fields entirely when the caller passes none', async () => {
  const bytes = await serializeVoxlDocumentV2(
    input({ plates: undefined, activePlateId: undefined, models: [model('m1')] }),
    meshMap(1),
  );

  // The SCNE chunk is uncompressed JSON, so a literal scan is a fair check
  // that a pre-plates project's bytes are unchanged.
  const text = new TextDecoder().decode(bytes);
  assert.equal(text.includes('"plates"'), false);
  assert.equal(text.includes('"activePlateId"'), false);
});

test('V2 reader synthesises one plate for a file written before plates existed', async () => {
  const bytes = await serializeVoxlDocumentV2(
    input({ plates: undefined, activePlateId: undefined, models: [model('m1'), model('m2')] }),
    meshMap(2),
  );
  const { document } = parseVoxlBinaryV2(bytes);

  assert.equal(document.scene.plates?.length, 1);
  assert.equal(document.scene.plates?.[0].slotIndex, 0);
  assert.deepEqual(document.scene.plates?.[0].offsetMm, { x: 0, y: 0 });

  const plateId = document.scene.plates?.[0].id;
  assert.ok(plateId);
  assert.equal(document.scene.activePlateId, plateId);
  // No model may be left orphaned.
  assert.deepEqual(document.models.map((m) => m.plateId), [plateId, plateId]);
});

test('V2 reader reassigns a model whose plateId matches no plate', async () => {
  const bytes = await serializeVoxlDocumentV2(
    input({ models: [model('m1', PLATE_A.id), model('m2', 'plate-that-was-deleted')] }),
    meshMap(2),
  );
  const { document } = parseVoxlBinaryV2(bytes);

  assert.equal(document.models[0].plateId, PLATE_A.id);
  // Dangling → first plate, never left dangling.
  assert.equal(document.models[1].plateId, PLATE_A.id);
});

test('identical-geometry dedup still shares one MESH chunk across plates', async () => {
  // Dedup is keyed on content SHA, which is plate-independent — but the Fill
  // Plate case (N copies of one mesh) is exactly what would regress if plate
  // data ever leaked into the chunk-ownership decision.
  const sharedSha = new Map([[0, 'same'], [1, 'same']]);
  const bytes = await serializeVoxlDocumentV2(
    input({ models: [model('m1', PLATE_A.id), model('m2', PLATE_B.id, 170)] }),
    meshMap(2),
    sharedSha,
  );

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunkCount = view.getUint32(8, true);
  let meshChunks = 0;
  for (let i = 0; i < chunkCount; i += 1) {
    const base = 16 + i * 20;
    const tag = String.fromCharCode(bytes[base], bytes[base + 1], bytes[base + 2], bytes[base + 3]);
    if (tag === 'MESH') meshChunks += 1;
  }
  assert.equal(meshChunks, 1, 'two identical meshes on different plates must share one chunk');

  const { document } = parseVoxlBinaryV2(bytes);
  assert.equal(document.models[0].plateId, PLATE_A.id);
  assert.equal(document.models[1].plateId, PLATE_B.id);
});

// ── V1 JSON roundtrip ─────────────────────────────────────────────────────

/** V1 validates embedded payloads, so these use external-file mesh refs. */
function v1Model(id: string, plateId?: string): VoxlModelRuntimeLike {
  return { ...model(id, plateId), mesh: { mode: 'external-file', fileName: `${id}.stl` } };
}

test('V1 JSON roundtrip preserves plates and plateId', () => {
  const document = buildVoxlDocumentV1(input({
    models: [v1Model('m1', PLATE_A.id), v1Model('m2', PLATE_B.id)],
  }));
  const json = serializeVoxlDocument(document, false, { compression: 'none' });
  const parsed = parseVoxlDocument(json);

  assert.deepEqual(parsed.scene.plates, [PLATE_A, PLATE_B]);
  assert.equal(parsed.scene.activePlateId, PLATE_B.id);
  assert.equal(parsed.models[1].plateId, PLATE_B.id);
});

test('V1 reader synthesises one plate for a legacy document', () => {
  const document = buildVoxlDocumentV1(input({
    plates: undefined,
    activePlateId: undefined,
    models: [v1Model('m1')],
  }));
  const json = serializeVoxlDocument(document, false, { compression: 'none' });
  assert.equal(json.includes('"plates"'), false);

  const parsed = parseVoxlDocument(json);
  assert.equal(parsed.scene.plates?.length, 1);
  assert.equal(parsed.models[0].plateId, parsed.scene.plates?.[0].id);
});

// ── Normalisation unit tests ──────────────────────────────────────────────

function scene(overrides: Partial<VoxlSceneState>): VoxlSceneState {
  return { activeModelId: null, selectedModelIds: [], ...overrides };
}

let idCounter = 0;
const makeId = () => `generated-${(idCounter += 1)}`;

test('normaliseVoxlPlates synthesises exactly one plate when none are present', () => {
  const result = normaliseVoxlPlates(scene({}), makeId);

  assert.equal(result.synthesised, true);
  assert.equal(result.plates.length, 1);
  assert.equal(result.plates[0].slotIndex, 0);
  assert.equal(result.activePlateId, result.plates[0].id);
});

test('normaliseVoxlPlates falls back to the first plate for an unresolvable activePlateId', () => {
  const result = normaliseVoxlPlates(scene({ plates: [PLATE_A, PLATE_B], activePlateId: 'nope' }), makeId);

  assert.equal(result.synthesised, false);
  assert.equal(result.activePlateId, PLATE_A.id);
});

test('normaliseVoxlPlates drops duplicate ids and forces unique slotIndex', () => {
  const result = normaliseVoxlPlates(
    scene({
      plates: [
        PLATE_A,
        { ...PLATE_A, name: 'duplicate id' },
        { id: 'plate-c', name: 'C', slotIndex: 0, offsetMm: { x: 0, y: 0 } },
      ],
    }),
    makeId,
  );

  assert.deepEqual(result.plates.map((p) => p.id), [PLATE_A.id, 'plate-c']);
  assert.deepEqual(result.plates.map((p) => p.slotIndex), [0, 1]);
});

test('normaliseVoxlPlates repairs a non-finite slotIndex and offset', () => {
  const broken = { id: 'x', name: '', slotIndex: Number.NaN, offsetMm: { x: Number.NaN, y: 3 } } as VoxlPlateEntry;
  const result = normaliseVoxlPlates(scene({ plates: [broken] }), makeId);

  assert.equal(result.plates[0].slotIndex, 0);
  assert.deepEqual(result.plates[0].offsetMm, { x: 0, y: 3 });
  assert.equal(result.plates[0].name, 'Plate 1');
});

test('reassignOrphanedModelPlates returns the same array when nothing is orphaned', () => {
  const models = [{ plateId: PLATE_A.id }, { plateId: PLATE_B.id }] as VoxlModelEntry[];
  assert.equal(reassignOrphanedModelPlates(models, [PLATE_A, PLATE_B]), models);
});

// ── Off-plate models ──────────────────────────────────────────────────────

test('V2 roundtrip preserves an off-plate model instead of adopting a plate', async () => {
  const bytes = await serializeVoxlDocumentV2(
    input({ models: [model('m1', PLATE_A.id), model('staged', OFF_PLATE_ID, 900)] }),
    meshMap(2),
  );
  const { document } = parseVoxlBinaryV2(bytes);

  const staged = document.models.find((entry) => entry.id === 'staged');
  assert.equal(staged?.plateId, OFF_PLATE_ID, 'the sentinel must survive the binary round trip');
  assert.equal(staged?.transform.position.x, 900, 'and its world position must be untouched');
  assert.equal(document.models.find((entry) => entry.id === 'm1')?.plateId, PLATE_A.id);
});

test('the sentinel is truthy, so the truthiness-guarded writer actually emits it', async () => {
  // Regression guard for the trap that ruled out `plateId: null`: both writers
  // use `...(plateId ? { plateId } : {})`, so a falsy off-plate marker would be
  // dropped on save and then repaired onto plate 1 on load.
  const bytes = await serializeVoxlDocumentV2(
    input({ models: [model('staged', OFF_PLATE_ID)] }),
    meshMap(1),
  );
  const { document } = parseVoxlBinaryV2(bytes);

  assert.ok(
    Object.prototype.hasOwnProperty.call(document.models[0], 'plateId'),
    'plateId must be present on the written entry, not omitted',
  );
});

test('V1 JSON roundtrip preserves an off-plate model', () => {
  const doc = buildVoxlDocumentV1(input({
    models: [{ ...v1Model('staged', OFF_PLATE_ID), transform: { position: { x: 900, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }],
  }));
  const parsed = parseVoxlDocument(serializeVoxlDocument(doc, false, { compression: 'none' }));

  assert.equal(parsed.models[0].plateId, OFF_PLATE_ID);
  assert.equal(parsed.models[0].transform.position.x, 900);
});

test('normalisation keeps an off-plate model but still repairs a dangling plateId', () => {
  const plates = [PLATE_A, PLATE_B];
  const models = [
    model('staged', OFF_PLATE_ID) as unknown as VoxlModelEntry,
    model('broken', 'plate-that-never-existed') as unknown as VoxlModelEntry,
    model('fine', PLATE_B.id) as unknown as VoxlModelEntry,
  ];

  const repaired = reassignOrphanedModelPlates(models, plates);

  assert.equal(repaired[0].plateId, OFF_PLATE_ID, 'a deliberate off-plate state is not a broken link');
  assert.equal(repaired[1].plateId, PLATE_A.id, 'a dangling uuid is still repaired to the first plate');
  assert.equal(repaired[2].plateId, PLATE_B.id);
});

test('an unstamped model is still adopted onto a plate, never left off-plate', () => {
  // The legacy path must not change meaning: `undefined` means "unstamped".
  const repaired = reassignOrphanedModelPlates(
    [model('legacy') as unknown as VoxlModelEntry],
    [PLATE_A, PLATE_B],
  );

  assert.equal(repaired[0].plateId, PLATE_A.id);
  assert.notEqual(repaired[0].plateId, OFF_PLATE_ID);
});
