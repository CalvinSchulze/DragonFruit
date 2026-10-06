import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import type { MaterialProfile, PrinterProfile } from '@/features/profiles/profileStore';
import { buildSolidSliceMeshForWasm } from '../rasterLayerZipExport';
import { getSnapshot, setSnapshot } from '@/supports/state';
import { createEmptySupportCollections } from '@/supports/supportTypeRegistry';
import { getRaftSettings, setRaftSettings } from '@/supports/Rafts/Crenelated/RaftState';
import { PLATE_GAP_MM, derivePlateOffset } from '@/features/scene/plates';

const BUILD_VOLUME = { width: 200, depth: 200, height: 200 };

const mockPrinterProfile: PrinterProfile = {
  id: 'test-printer',
  name: 'Test Printer',
  manufacturer: 'Test',
  buildVolumeMm: BUILD_VOLUME,
  display: {
    resolutionX: 1000,
    resolutionY: 1000,
    outputFormat: '.nanodlp',
    mirrorX: false,
    mirrorY: false,
  },
} as PrinterProfile;

const mockMaterialProfile: MaterialProfile = {
  id: 'test-material',
  name: 'Test Material',
  layerHeightMm: 0.05,
} as MaterialProfile;

/**
 * A real box sitting on the plate, so the raft generator has a footprint to
 * work from. `at` is the model's world position — on plate 0 that is the world
 * origin, on plate N it is the plate's offset.
 */
function createBoxModel(id: string, at: { x: number; y: number }): LoadedModel {
  const geometry = new THREE.BoxGeometry(20, 20, 20);
  geometry.translate(0, 0, 10); // Base flush with z = 0.

  return {
    id,
    name: id,
    visible: true,
    color: '#a3a3a3',
    polygonCount: 12,
    isSupportGeometry: false,
    fileUrl: '',
    geometry: {
      geometry,
      bbox: new THREE.Box3(new THREE.Vector3(-10, -10, 0), new THREE.Vector3(10, 10, 20)),
      center: new THREE.Vector3(0, 0, 10),
      size: new THREE.Vector3(20, 20, 20),
      flatteningPlanes: [],
    },
    transform: {
      position: new THREE.Vector3(at.x, at.y, 0),
      rotation: new THREE.Euler(0, 0, 0),
      scale: new THREE.Vector3(1, 1, 1),
    },
  } as unknown as LoadedModel;
}

/** A twig whose contact disks hang off the box, in world space like the model. */
function createTwigAt(modelId: string, at: { x: number; y: number }) {
  const disk = (dx: number, dy: number, z: number, diameter: number, normalZ: number) => ({
    id: `${modelId}-disk-${dx}-${dy}`,
    pos: { x: at.x + dx, y: at.y + dy, z },
    surfaceNormal: { x: 0, y: 0, z: normalZ },
    coneAxis: { x: 0, y: 0, z: normalZ },
    contactDiameterMm: diameter,
    profile: {
      type: 'disk' as const,
      contactDiameterMm: diameter,
      diskThicknessMm: 0.2,
      maxStandoffMm: 0.35,
      standoffAngleThreshold: Math.PI / 4,
    },
  });

  return {
    id: `${modelId}-twig`,
    modelId,
    segments: [],
    contactDiskA: disk(0, 0, 20, 1.0, 1),
    contactDiskB: disk(4, 4, 15, 2.0, -1),
  };
}

/**
 * A support root at the model's feet. The raft is generated from root circles,
 * so without one `bottomMode: 'solid'` emits nothing — and roots are world
 * space like everything else, which is the part worth proving.
 */
function createRootAt(modelId: string, at: { x: number; y: number }) {
  return {
    id: `${modelId}-root`,
    modelId,
    transform: {
      pos: { x: at.x, y: at.y, z: 0 },
      rot: { x: 0, y: 0, z: 0, w: 1 },
    },
    diameter: 3,
    diskHeight: 0.4,
    coneHeight: 0.6,
  };
}

function emptySupportState() {
  return {
    ...createEmptySupportCollections(),
    selectedId: null,
    hoveredId: null,
    selectedCategory: null,
    hoveredCategory: 'none' as const,
    interactionWarning: null,
  };
}

async function sliceOnPlate(options: {
  modelId: string;
  at: { x: number; y: number };
  plateOffsetMm?: { x: number; y: number };
  withSupports: boolean;
}): Promise<Float32Array> {
  const model = createBoxModel(options.modelId, options.at);
  const savedSupportState = getSnapshot();
  try {
    setSnapshot(
      options.withSupports
        ? {
          ...emptySupportState(),
          twigs: { [`${options.modelId}-twig`]: createTwigAt(options.modelId, options.at) as never },
          roots: { [`${options.modelId}-root`]: createRootAt(options.modelId, options.at) as never },
        }
        : emptySupportState(),
    );

    const mesh = await buildSolidSliceMeshForWasm({
      models: [model],
      printerProfile: mockPrinterProfile,
      materialProfile: mockMaterialProfile,
      filenameBase: 'plate_offset_test',
      ...(options.plateOffsetMm ? { plateOffsetMm: options.plateOffsetMm } : {}),
    });
    // finalize() can hand back the backing buffer; copy before the next slice.
    return Float32Array.from(mesh.trianglesXYZ);
  } finally {
    setSnapshot(savedSupportState);
    model.geometry.geometry.dispose();
  }
}

function boundsOf(triangles: Float32Array) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < triangles.length; i += 3) {
    minX = Math.min(minX, triangles[i]);
    maxX = Math.max(maxX, triangles[i]);
    minY = Math.min(minY, triangles[i + 1]);
    maxY = Math.max(maxY, triangles[i + 1]);
  }
  return { minX, maxX, minY, maxY };
}

test('an omitted plate offset is byte-identical to an explicit zero offset', async () => {
  const withoutOffset = await sliceOnPlate({ modelId: 'm1', at: { x: 0, y: 0 }, withSupports: true });
  const withZeroOffset = await sliceOnPlate({
    modelId: 'm1',
    at: { x: 0, y: 0 },
    plateOffsetMm: { x: 0, y: 0 },
    withSupports: true,
  });

  assert.ok(withoutOffset.length > 36, 'expected model and support triangles');
  assert.equal(withZeroOffset.length, withoutOffset.length);
  assert.deepEqual(
    new Uint8Array(withZeroOffset.buffer, withZeroOffset.byteOffset, withZeroOffset.byteLength),
    new Uint8Array(withoutOffset.buffer, withoutOffset.byteOffset, withoutOffset.byteLength),
    'slot 0 must not perturb a single byte of the prepared mesh',
  );
});

test('a plate offset translates X and Y and leaves Z untouched', async () => {
  const atOrigin = await sliceOnPlate({ modelId: 'm1', at: { x: 0, y: 0 }, withSupports: true });
  const offset = { x: 30, y: -12.5 };
  const shifted = await sliceOnPlate({
    modelId: 'm1',
    at: { x: 0, y: 0 },
    plateOffsetMm: offset,
    withSupports: true,
  });

  assert.equal(shifted.length, atOrigin.length);
  for (let i = 0; i < atOrigin.length; i += 3) {
    assert.ok(Math.abs(shifted[i] - (atOrigin[i] - offset.x)) < 1e-4, `X at float ${i}`);
    assert.ok(Math.abs(shifted[i + 1] - (atOrigin[i + 1] - offset.y)) < 1e-4, `Y at float ${i}`);
    assert.equal(shifted[i + 2], atOrigin[i + 2], `Z at float ${i} must be untouched`);
  }
});

test('slicing plate 2 centres its models, supports and raft exactly as if it were the only plate', async () => {
  const plate1Offset = derivePlateOffset(0, { widthMm: BUILD_VOLUME.width, depthMm: BUILD_VOLUME.depth });
  const plate2Offset = derivePlateOffset(1, { widthMm: BUILD_VOLUME.width, depthMm: BUILD_VOLUME.depth });
  assert.deepEqual(plate1Offset, { x: 0, y: 0 });
  assert.deepEqual(plate2Offset, { x: BUILD_VOLUME.width + PLATE_GAP_MM, y: 0 });

  const savedRaftSettings = getRaftSettings();
  try {
    // A raft is part of what the plate contributes, so prove it offsets too.
    setRaftSettings({ ...savedRaftSettings, bottomMode: 'solid' });

    const onPlate1 = await sliceOnPlate({ modelId: 'm1', at: plate1Offset, withSupports: true });
    const onPlate2 = await sliceOnPlate({
      modelId: 'm1',
      at: plate2Offset,
      plateOffsetMm: plate2Offset,
      withSupports: true,
    });

    assert.equal(onPlate2.length, onPlate1.length, 'the same scene must produce the same triangle count on any plate');

    for (let i = 0; i < onPlate1.length; i += 1) {
      assert.ok(
        Math.abs(onPlate2[i] - onPlate1[i]) < 1e-3,
        `float ${i}: plate 2 produced ${onPlate2[i]}, plate 1 produced ${onPlate1[i]}`,
      );
    }

    // And the result really does sit inside the build volume, not 220 mm away.
    const bounds = boundsOf(onPlate2);
    const halfWidth = BUILD_VOLUME.width * 0.5;
    const halfDepth = BUILD_VOLUME.depth * 0.5;
    assert.ok(bounds.minX >= -halfWidth && bounds.maxX <= halfWidth, `X within volume: ${bounds.minX}..${bounds.maxX}`);
    assert.ok(bounds.minY >= -halfDepth && bounds.maxY <= halfDepth, `Y within volume: ${bounds.minY}..${bounds.maxY}`);
  } finally {
    setRaftSettings(savedRaftSettings);
  }
});
