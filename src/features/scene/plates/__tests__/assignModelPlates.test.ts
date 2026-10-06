import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import {
  OFF_PLATE_ID,
  assignModelPlates,
  createPlate,
  type Plate,
  type PlateAssignableModel,
  type PlateBuildVolume,
} from '@/features/scene/plates';

/**
 * Plate membership is re-derived from geometry at exactly two moments: a model
 * arriving without a `plateId`, and a model whose transform changed. Everything
 * else must leave `plateId` alone.
 */

const BUILD_VOLUME: PlateBuildVolume = { widthMm: 200, depthMm: 100, originMode: 'center' };

function model(id: string, x: number, plateId?: string): PlateAssignableModel {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));

  return {
    id,
    ...(plateId ? { plateId } : {}),
    geometry: {
      geometry,
      bbox: new THREE.Box3(new THREE.Vector3(-10, -10, 0), new THREE.Vector3(10, 10, 20)),
      center: new THREE.Vector3(0, 0, 10),
    },
    transform: {
      position: new THREE.Vector3(x, 0, 0),
      rotation: new THREE.Euler(0, 0, 0),
      scale: new THREE.Vector3(1, 1, 1),
    },
  };
}

function plateState(plates: Plate[]) {
  return { plates, activePlateId: plates[0].id, buildVolume: BUILD_VOLUME };
}

test('a new model over the active plate is adopted by it', () => {
  const plates = [createPlate(0, BUILD_VOLUME)];
  const assigned = assignModelPlates([model('m1', 0)], [], plateState(plates));

  assert.equal(assigned[0].plateId, plates[0].id);
});

test('a new model clear of every plate is staged off-plate', () => {
  const plates = [createPlate(0, BUILD_VOLUME)];
  const assigned = assignModelPlates([model('far', 900)], [], plateState(plates));

  assert.equal(assigned[0].plateId, OFF_PLATE_ID);
});

test('Lychee import: a multi-plate project arrives part on-plate, part staged', () => {
  // The LYS plugin replays Lychee's authored world coordinates verbatim, so a
  // project whose models spanned several Lychee plates lands with one plate's
  // worth over our plate and the rest far out in empty space.
  const plates = [createPlate(0, BUILD_VOLUME)];
  const imported = [model('onPlate', 0), model('scattered1', 420), model('scattered2', 840)];

  const assigned = assignModelPlates(imported, [], plateState(plates));

  assert.equal(assigned[0].plateId, plates[0].id);
  assert.equal(assigned[1].plateId, OFF_PLATE_ID);
  assert.equal(assigned[2].plateId, OFF_PLATE_ID);
});

test('a model loaded with an explicit plateId keeps it, so repack stays in charge', () => {
  const plates = [createPlate(0, BUILD_VOLUME), createPlate(1, BUILD_VOLUME)];
  // Positioned nowhere near plate 2, but the file says plate 2 — leave it be.
  const loaded = [model('m1', 0, plates[1].id)];

  const assigned = assignModelPlates(loaded, [], plateState(plates));

  assert.equal(assigned[0].plateId, plates[1].id);
  assert.strictEqual(assigned, loaded, 'nothing changed, so the array is returned as-is');
});

test('an explicit off-plate model is never re-adopted by an unrelated write', () => {
  const plates = [createPlate(0, BUILD_VOLUME)];
  // Sitting right over the plate, but deliberately off it.
  const staged = model('staged', 0, OFF_PLATE_ID);
  const previous = [staged];

  // Same transform, only an unrelated field changed.
  const assigned = assignModelPlates([{ ...staged }], previous, plateState(plates));

  assert.equal(assigned[0].plateId, OFF_PLATE_ID);
});

test('dragging a model clear of every plate stages it', () => {
  const plates = [createPlate(0, BUILD_VOLUME)];
  const before = model('m1', 0, plates[0].id);

  const assigned = assignModelPlates([model('m1', 900, plates[0].id)], [before], plateState(plates));

  assert.equal(assigned[0].plateId, OFF_PLATE_ID);
});

test('dragging a staged model back onto a plate re-adopts it', () => {
  const plates = [createPlate(0, BUILD_VOLUME)];
  const before = model('m1', 900, OFF_PLATE_ID);

  const assigned = assignModelPlates([model('m1', 0, OFF_PLATE_ID)], [before], plateState(plates));

  assert.equal(assigned[0].plateId, plates[0].id);
});

test('a nudge that still overlaps the current plate never shuffles it to another', () => {
  const plates = [createPlate(0, BUILD_VOLUME), createPlate(1, BUILD_VOLUME)];
  // On plate 2, nudged slightly — it also reaches back toward plate 1's edge.
  const before = model('m1', 220, plates[1].id);

  const assigned = assignModelPlates([model('m1', 215, plates[1].id)], [before], plateState(plates));

  assert.equal(assigned[0].plateId, plates[1].id);
});

test('with no plates yet, assignment is a no-op rather than a guess', () => {
  const models = [model('m1', 0)];
  assert.strictEqual(assignModelPlates(models, [], { plates: [], activePlateId: null, buildVolume: BUILD_VOLUME }), models);
});
