import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPlate,
  defaultPlateName,
  derivePlateOffset,
  lowestFreeSlotIndex,
  plateOffsetsEqual,
  platesNeedRepack,
  resolveModelPlateId,
} from '@/features/scene/plates/plateLayout';
import { DEFAULT_PLATE_NAME, PLATE_GAP_MM, type Plate, type PlateBuildVolume } from '@/features/scene/plates/types';

const BUILD_VOLUME: PlateBuildVolume = { widthMm: 150, depthMm: 80 };

function plateAtSlot(slotIndex: number, overrides?: Partial<Plate>): Plate {
  return { ...createPlate(slotIndex, BUILD_VOLUME), ...overrides };
}

test('derivePlateOffset puts slot 0 on the world origin', () => {
  assert.deepEqual(derivePlateOffset(0, BUILD_VOLUME), { x: 0, y: 0 });
});

test('derivePlateOffset lays plates out in a single row along +X', () => {
  const pitch = BUILD_VOLUME.widthMm + PLATE_GAP_MM;
  assert.deepEqual(derivePlateOffset(1, BUILD_VOLUME), { x: pitch, y: 0 });
  assert.deepEqual(derivePlateOffset(3, BUILD_VOLUME), { x: 3 * pitch, y: 0 });
});

test('derivePlateOffset tolerates a degenerate build volume', () => {
  assert.deepEqual(derivePlateOffset(2, { widthMm: 0, depthMm: 0 }), { x: 2 * PLATE_GAP_MM, y: 0 });
  assert.deepEqual(derivePlateOffset(-4, BUILD_VOLUME), { x: 0, y: 0 });
});

test('lowestFreeSlotIndex reclaims the hole left by a deleted plate', () => {
  assert.equal(lowestFreeSlotIndex([]), 0);
  assert.equal(lowestFreeSlotIndex([plateAtSlot(0), plateAtSlot(1)]), 2);
  assert.equal(lowestFreeSlotIndex([plateAtSlot(0), plateAtSlot(2)]), 1);
  assert.equal(lowestFreeSlotIndex([plateAtSlot(1), plateAtSlot(2)]), 0);
});

test('defaultPlateName is one-based', () => {
  assert.equal(defaultPlateName(0), DEFAULT_PLATE_NAME);
  assert.equal(defaultPlateName(1), 'Plate 2');
});

test('createPlate records the derived offset and a unique id', () => {
  const first = createPlate(0, BUILD_VOLUME);
  const second = createPlate(1, BUILD_VOLUME);

  assert.notEqual(first.id, second.id);
  assert.equal(first.slotIndex, 0);
  assert.equal(first.name, DEFAULT_PLATE_NAME);
  assert.deepEqual(first.offsetMm, { x: 0, y: 0 });
  assert.deepEqual(second.offsetMm, derivePlateOffset(1, BUILD_VOLUME));
});

test('createPlate honours an explicit name but falls back when blank', () => {
  assert.equal(createPlate(0, BUILD_VOLUME, '  Minis  ').name, 'Minis');
  assert.equal(createPlate(1, BUILD_VOLUME, '   ').name, 'Plate 2');
});

test('plateOffsetsEqual ignores floating point dust', () => {
  assert.equal(plateOffsetsEqual({ x: 170, y: 0 }, { x: 170 + 1e-9, y: 0 }), true);
  assert.equal(plateOffsetsEqual({ x: 170, y: 0 }, { x: 170.01, y: 0 }), false);
});

test('platesNeedRepack is false while the build volume is unchanged', () => {
  const plates = [plateAtSlot(0), plateAtSlot(1)];
  assert.equal(platesNeedRepack(plates, BUILD_VOLUME), false);
});

test('platesNeedRepack detects a build volume change', () => {
  const plates = [plateAtSlot(0), plateAtSlot(1)];
  assert.equal(platesNeedRepack(plates, { widthMm: 220, depthMm: 120 }), true);
});

test('platesNeedRepack ignores a width change when only slot 0 exists', () => {
  // Slot 0 always sits on the origin, so a single-plate project never repacks.
  assert.equal(platesNeedRepack([plateAtSlot(0)], { widthMm: 220, depthMm: 120 }), false);
});

test('resolveModelPlateId falls back to the active plate', () => {
  assert.equal(resolveModelPlateId({ plateId: 'plate-a' }, 'plate-b'), 'plate-a');
  assert.equal(resolveModelPlateId({}, 'plate-b'), 'plate-b');
});
