import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { addRoot, getSnapshot, resetStore } from '@/supports/state';

import { repackPlates, type RepackableModel } from '@/features/scene/plates/repackPlates';
import { OFF_PLATE_ID, PLATE_GAP_MM, type Plate, type PlateBuildVolume } from '@/features/scene/plates/types';

/**
 * D6: when the build volume changes, every plate from slot 1 onwards moves,
 * and its member models — and their supports, which store absolute world
 * positions — have to move with it.
 */

const SMALL: PlateBuildVolume = { widthMm: 150, depthMm: 80 };
const LARGE: PlateBuildVolume = { widthMm: 220, depthMm: 120 };

const SMALL_PITCH = SMALL.widthMm + PLATE_GAP_MM;   // 170
const LARGE_PITCH = LARGE.widthMm + PLATE_GAP_MM;   // 240

function plate(id: string, slotIndex: number, offsetX: number): Plate {
  return { id, name: `Plate ${slotIndex + 1}`, slotIndex, offsetMm: { x: offsetX, y: 0 } };
}

function sceneModel(id: string, plateId: string, x: number): RepackableModel {
  return {
    id,
    plateId,
    transform: {
      position: new THREE.Vector3(x, 5, 0),
      rotation: new THREE.Euler(0, 0, 0),
      scale: new THREE.Vector3(1, 1, 1),
    },
  };
}

function seedRootAt(modelId: string, x: number, y: number): void {
  addRoot({
    id: `root-${modelId}`,
    modelId,
    transform: { pos: { x, y, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
    diameter: 3,
    diskHeight: 0.5,
    coneHeight: 1.5,
  } as never);
}

test('repackPlates is a no-op while the build volume is unchanged', () => {
  resetStore();
  const plates = [plate('p0', 0, 0), plate('p1', 1, SMALL_PITCH)];
  const models = [sceneModel('m0', 'p0', 10), sceneModel('m1', 'p1', SMALL_PITCH + 10)];

  const result = repackPlates(plates, models, SMALL, 'p0');

  assert.equal(result.movedModelCount, 0);
  assert.deepEqual(result.movedPlateIds, []);
  // Same array instances: nothing allocated on the common path.
  assert.equal(result.models, models);
  assert.equal(result.plates, plates);
});

test('a single-plate project never repacks, because slot 0 is always the origin', () => {
  resetStore();
  const plates = [plate('p0', 0, 0)];
  const models = [sceneModel('m0', 'p0', 10)];

  const result = repackPlates(plates, models, LARGE, 'p0');

  assert.equal(result.movedModelCount, 0);
  assert.equal(result.models[0].transform.position.x, 10);
});

test('a wider build volume translates slot-1 models by the pitch delta', () => {
  resetStore();
  const plates = [plate('p0', 0, 0), plate('p1', 1, SMALL_PITCH)];
  const models = [sceneModel('m0', 'p0', 10), sceneModel('m1', 'p1', SMALL_PITCH + 10)];

  const result = repackPlates(plates, models, LARGE, 'p0');
  const delta = LARGE_PITCH - SMALL_PITCH;   // 70

  assert.equal(result.movedModelCount, 1);
  assert.deepEqual(result.movedPlateIds, ['p1']);

  // Slot 0 is untouched.
  assert.equal(result.models[0].transform.position.x, 10);
  // Slot 1 moved by exactly the delta, and only in X.
  assert.equal(result.models[1].transform.position.x, SMALL_PITCH + 10 + delta);
  assert.equal(result.models[1].transform.position.y, 5);
  assert.equal(result.models[1].transform.position.z, 0);

  // The plate now records the offset its members were written against.
  assert.deepEqual(result.plates[1].offsetMm, { x: LARGE_PITCH, y: 0 });
  assert.deepEqual(result.plates[0].offsetMm, { x: 0, y: 0 });
});

test('supports travel with their model', () => {
  resetStore();
  const plates = [plate('p0', 0, 0), plate('p1', 1, SMALL_PITCH)];
  const models = [sceneModel('m0', 'p0', 10), sceneModel('m1', 'p1', SMALL_PITCH + 10)];

  seedRootAt('m0', 10, 5);
  seedRootAt('m1', SMALL_PITCH + 10, 5);

  repackPlates(plates, models, LARGE, 'p0');
  const delta = LARGE_PITCH - SMALL_PITCH;

  const roots = getSnapshot().roots;
  // Slot 0's support must not have moved.
  assert.equal(roots['root-m0'].transform.pos.x, 10);
  // Slot 1's support moved with its model — supports store absolute positions.
  assert.equal(roots['root-m1'].transform.pos.x, SMALL_PITCH + 10 + delta);
  assert.equal(roots['root-m1'].transform.pos.y, 5);
});

test('a model with no explicit plateId is treated as being on the active plate', () => {
  resetStore();
  const plates = [plate('p0', 0, 0), plate('p1', 1, SMALL_PITCH)];
  const unstamped: RepackableModel = {
    id: 'm-unstamped',
    transform: {
      position: new THREE.Vector3(SMALL_PITCH + 10, 5, 0),
      rotation: new THREE.Euler(0, 0, 0),
      scale: new THREE.Vector3(1, 1, 1),
    },
  };

  // Active plate is the one that moved, so the unstamped model moves too.
  const result = repackPlates(plates, [unstamped], LARGE, 'p1');

  assert.equal(result.movedModelCount, 1);
  assert.equal(result.models[0].transform.position.x, SMALL_PITCH + 10 + (LARGE_PITCH - SMALL_PITCH));
});

test('a narrower build volume moves plates back toward the origin', () => {
  resetStore();
  const plates = [plate('p0', 0, 0), plate('p1', 1, LARGE_PITCH)];
  const models = [sceneModel('m1', 'p1', LARGE_PITCH)];

  const result = repackPlates(plates, models, SMALL, 'p0');

  assert.equal(result.models[0].transform.position.x, SMALL_PITCH);
  assert.deepEqual(result.plates[1].offsetMm, { x: SMALL_PITCH, y: 0 });
});

test('offPlateModelsAreNeverRepacked: a staged model keeps its transform and supports', () => {
  resetStore();

  const plates = [plate('p0', 0, 0), plate('p1', 1, SMALL_PITCH)];
  // Staged far out in world space, where no plate reaches.
  const staged = sceneModel('staged', OFF_PLATE_ID, 900);
  const onPlate1 = sceneModel('m1', 'p1', SMALL_PITCH);
  seedRootAt('staged', 900, 5);
  seedRootAt('m1', SMALL_PITCH, 5);

  const result = repackPlates(plates, [staged, onPlate1], LARGE, 'p0');

  // The plate-1 model moved with its plate…
  assert.equal(result.movedModelCount, 1, 'only the plate member moves');
  const movedModel = result.models.find((model) => model.id === 'm1');
  assert.equal(movedModel?.transform.position.x, LARGE_PITCH);

  // …while the staged model is untouched, object identity included.
  const stagedAfter = result.models.find((model) => model.id === 'staged');
  assert.strictEqual(stagedAfter, staged, 'an off-plate model must not even be cloned');
  assert.equal(stagedAfter?.transform.position.x, 900);
  assert.equal(getSnapshot().roots['root-staged'].transform.pos.x, 900, 'and its supports stay put');
  assert.equal(getSnapshot().roots['root-m1'].transform.pos.x, LARGE_PITCH);
});

test('an off-plate model does not make a single-plate project look like it needs a repack', () => {
  resetStore();

  const plates = [plate('p0', 0, 0)];
  const staged = sceneModel('staged', OFF_PLATE_ID, 900);

  const result = repackPlates(plates, [staged], SMALL, 'p0');

  assert.equal(result.movedModelCount, 0);
  assert.deepEqual(result.movedPlateIds, []);
  assert.strictEqual(result.models, result.models, 'no reallocation when nothing moves');
});
