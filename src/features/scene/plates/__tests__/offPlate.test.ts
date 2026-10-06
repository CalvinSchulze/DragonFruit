import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OFF_PLATE_ID,
  PLATE_GAP_MM,
  classifyModelPlate,
  createPlate,
  isOffPlate,
  plateFootprintRect,
  resolveModelPlateId,
  type Plate,
  type PlateFootprintRect,
} from '../index';

const BUILD_VOLUME = { widthMm: 200, depthMm: 100 };

function rect(minX: number, minY: number, maxX: number, maxY: number): PlateFootprintRect {
  return { minX, minY, maxX, maxY };
}

function platesForSlots(slots: readonly number[]): Plate[] {
  return slots.map((slot) => createPlate(slot, BUILD_VOLUME));
}

test('OFF_PLATE_ID is a non-empty, non-uuid string so it survives the writers', () => {
  assert.equal(typeof OFF_PLATE_ID, 'string');
  assert.ok(OFF_PLATE_ID.length > 0, 'a falsy sentinel would be dropped by the truthiness-guarded writers');
  assert.ok(Boolean(OFF_PLATE_ID), 'must be truthy');
  assert.doesNotMatch(
    OFF_PLATE_ID,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    'must never be mistakable for a generated plate id',
  );
});

test('isOffPlate distinguishes the sentinel from a real id and from an absence', () => {
  assert.equal(isOffPlate(OFF_PLATE_ID), true);
  assert.equal(isOffPlate(createPlate(0, BUILD_VOLUME).id), false);
  assert.equal(isOffPlate(undefined), false, 'unstamped is not off-plate');
  assert.equal(isOffPlate(null), false);
});

test('resolveModelPlateId passes the sentinel through but still adopts for an absence', () => {
  assert.equal(resolveModelPlateId({ plateId: OFF_PLATE_ID }, 'active-1'), OFF_PLATE_ID);
  assert.equal(resolveModelPlateId({}, 'active-1'), 'active-1');
  assert.notEqual(resolveModelPlateId({ plateId: OFF_PLATE_ID }, 'active-1'), 'active-1');
});

test('plateFootprintRect honours originMode and the plate offset', () => {
  const [plate0, plate1] = platesForSlots([0, 1]);

  assert.deepEqual(plateFootprintRect(plate0, BUILD_VOLUME), rect(-100, -50, 100, 50));

  const pitch = BUILD_VOLUME.widthMm + PLATE_GAP_MM;
  assert.deepEqual(plateFootprintRect(plate1, BUILD_VOLUME), rect(pitch - 100, -50, pitch + 100, 50));

  assert.deepEqual(
    plateFootprintRect(plate0, { ...BUILD_VOLUME, originMode: 'front_left' }),
    rect(0, 0, 200, 100),
  );
});

test('a model over a plate classifies onto it; one straddling the edge still belongs to it', () => {
  const plates = platesForSlots([0, 1]);

  assert.equal(classifyModelPlate(rect(-5, -5, 5, 5), plates, BUILD_VOLUME), plates[0].id);
  // Overlap, not containment: an oversized model is out of bounds on its plate,
  // never homeless.
  assert.equal(classifyModelPlate(rect(60, -5, 400, 5), plates, BUILD_VOLUME), plates[0].id);
});

test('a model in the gap between plates is off-plate', () => {
  const plates = platesForSlots([0, 1]);
  const gapCentre = BUILD_VOLUME.widthMm * 0.5 + PLATE_GAP_MM * 0.5;

  assert.equal(classifyModelPlate(rect(gapCentre - 2, -5, gapCentre + 2, 5), plates, BUILD_VOLUME), OFF_PLATE_ID);
});

test('Lychee-style scatter: a model at a second plate\'s world coordinates is off-plate on a one-plate project', () => {
  // What the LYS importer produces for a multi-plate Lychee project: raw world
  // coordinates, far from the only plate this project has.
  const plates = platesForSlots([0]);
  const far = BUILD_VOLUME.widthMm + PLATE_GAP_MM;

  assert.equal(classifyModelPlate(rect(far - 10, -5, far + 10, 5), plates, BUILD_VOLUME), OFF_PLATE_ID);

  // …and the same scene, once a second plate exists, puts it on that plate.
  const twoPlates = platesForSlots([0, 1]);
  assert.equal(classifyModelPlate(rect(far - 10, -5, far + 10, 5), twoPlates, BUILD_VOLUME), twoPlates[1].id);
});

test('classification is independent of plate array order', () => {
  const plates = platesForSlots([0, 1]);
  const onPlate0 = rect(-5, -5, 5, 5);

  assert.equal(
    classifyModelPlate(onPlate0, plates, BUILD_VOLUME),
    classifyModelPlate(onPlate0, [...plates].reverse(), BUILD_VOLUME),
  );
});

test('plate membership ignores Z: a lifted model stays on its plate', () => {
  // classifyModelPlate takes a plan-view rect precisely so height cannot
  // unassign a lifted or tilted model.
  const plates = platesForSlots([0]);
  assert.equal(classifyModelPlate(rect(-5, -5, 5, 5), plates, BUILD_VOLUME), plates[0].id);
});

test('a project with no plates leaves every model off-plate rather than guessing', () => {
  assert.equal(classifyModelPlate(rect(-5, -5, 5, 5), [], BUILD_VOLUME), OFF_PLATE_ID);
});
