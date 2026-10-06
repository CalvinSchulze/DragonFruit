import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_PLATES,
  OFF_PLATE_ID,
  PLATE_GAP_MM,
  addPlateToSet,
  canAddPlate,
  countModelsByPlate,
  createPlate,
  duplicatePlateName,
  plateOffsetDelta,
  removePlateFromSet,
  renamePlateInSet,
  sortPlatesBySlot,
  type Plate,
} from '../index';

const BUILD_VOLUME = { widthMm: 200, depthMm: 100 };
const PITCH = BUILD_VOLUME.widthMm + PLATE_GAP_MM;

function platesForSlots(slots: readonly number[]): Plate[] {
  return slots.map((slot) => createPlate(slot, BUILD_VOLUME));
}

test('sortPlatesBySlot orders by slot without mutating the input', () => {
  const plates = platesForSlots([2, 0, 1]);
  const sorted = sortPlatesBySlot(plates);

  assert.deepEqual(sorted.map((plate) => plate.slotIndex), [0, 1, 2]);
  assert.deepEqual(plates.map((plate) => plate.slotIndex), [2, 0, 1]);
});

test('addPlateToSet appends the next slot, in tab order', () => {
  const added = addPlateToSet(platesForSlots([0]), BUILD_VOLUME);

  assert.ok(added);
  assert.equal(added.plate.slotIndex, 1);
  assert.equal(added.plate.name, 'Plate 2');
  assert.deepEqual(added.plate.offsetMm, { x: PITCH, y: 0 });
  assert.deepEqual(added.plates.map((plate) => plate.slotIndex), [0, 1]);
});

test('addPlateToSet reclaims a freed slot rather than extending the row', () => {
  const plates = platesForSlots([0, 2]);
  const added = addPlateToSet(plates, BUILD_VOLUME);

  assert.ok(added);
  assert.equal(added.plate.slotIndex, 1, 'the hole left by a deleted plate comes back first');
  assert.deepEqual(added.plates.map((plate) => plate.slotIndex), [0, 1, 2]);
});

test('addPlateToSet honours an explicit name and refuses to exceed MAX_PLATES', () => {
  const named = addPlateToSet(platesForSlots([0]), BUILD_VOLUME, '  Minis  ');
  assert.equal(named?.plate.name, 'Minis');

  const full = platesForSlots(Array.from({ length: MAX_PLATES }, (_, index) => index));
  assert.equal(canAddPlate(full), false);
  assert.equal(addPlateToSet(full, BUILD_VOLUME), null);
});

test('removePlateFromSet refuses the last plate and unknown ids', () => {
  const plates = platesForSlots([0]);

  const last = removePlateFromSet(plates, plates[0].id, plates[0].id);
  assert.equal(last.changed, false);
  assert.equal(last.plates.length, 1, 'invariant 1: a project always owns at least one plate');

  const unknown = removePlateFromSet(platesForSlots([0, 1]), plates[0].id, 'no-such-plate');
  assert.equal(unknown.changed, false);
});

test('removePlateFromSet keeps the active plate when another one is deleted', () => {
  const [plate0, plate1, plate2] = platesForSlots([0, 1, 2]);
  const result = removePlateFromSet([plate0, plate1, plate2], plate0.id, plate2.id);

  assert.equal(result.changed, true);
  assert.equal(result.activePlateId, plate0.id);
  assert.deepEqual(result.plates.map((plate) => plate.id), [plate0.id, plate1.id]);
});

test('deleting the active plate activates the nearest survivor by slot', () => {
  const [plate0, plate2, plate3] = platesForSlots([0, 2, 3]);

  const result = removePlateFromSet([plate0, plate2, plate3], plate2.id, plate2.id);
  assert.equal(result.changed, true);
  assert.equal(result.activePlateId, plate3.id, 'slot 3 is one away, slot 0 is two');

  // Equidistant neighbours go to the lower slot, so the result never depends
  // on array order.
  const [low, middle, high] = platesForSlots([0, 1, 2]);
  assert.equal(
    removePlateFromSet([high, middle, low], middle.id, middle.id).activePlateId,
    low.id,
  );
});

test('renamePlateInSet trims, falls back to the default name, and reports no-ops', () => {
  const plates = platesForSlots([0, 1]);

  assert.equal(renamePlateInSet(plates, 'no-such-plate', 'x'), null);
  assert.equal(renamePlateInSet(plates, plates[0].id, '  Plate 1  '), null, 'same name is a no-op');

  const renamed = renamePlateInSet(plates, plates[1].id, '  Busts  ');
  assert.equal(renamed?.[1].name, 'Busts');
  assert.equal(renamed?.[0].name, plates[0].name, 'other plates are untouched');

  const blanked = renamePlateInSet(renamed as Plate[], plates[1].id, '   ');
  assert.equal(blanked?.[1].name, 'Plate 2', 'a blank name can never leave an unlabelled tab');
});

test('duplicatePlateName avoids colliding with an existing name', () => {
  const plates = platesForSlots([0]);

  assert.equal(duplicatePlateName(plates, plates[0]), 'Plate 1 Copy');

  const withCopy = [...plates, { ...plates[0], id: 'copy-1', name: 'Plate 1 Copy' }];
  assert.equal(duplicatePlateName(withCopy, plates[0]), 'Plate 1 Copy 2');

  const withTwoCopies = [...withCopy, { ...plates[0], id: 'copy-2', name: 'Plate 1 Copy 2' }];
  assert.equal(duplicatePlateName(withTwoCopies, plates[0]), 'Plate 1 Copy 3');
});

test('plateOffsetDelta reads the recorded offsets, in both directions', () => {
  const [plate0, plate2] = platesForSlots([0, 2]);

  assert.deepEqual(plateOffsetDelta(plate0, plate2), { x: 2 * PITCH, y: 0 });
  assert.deepEqual(plateOffsetDelta(plate2, plate0), { x: -2 * PITCH, y: 0 });
});

test('countModelsByPlate counts every plate, plus the off-plate bucket', () => {
  const [plate0, plate1] = platesForSlots([0, 1]);

  const counts = countModelsByPlate(
    [
      { plateId: plate0.id },
      { plateId: plate0.id },
      { plateId: plate1.id },
      { plateId: OFF_PLATE_ID },
      // Unstamped: a legacy model resolves to the active plate.
      {},
    ],
    plate0.id,
  );

  assert.equal(counts.byPlateId.get(plate0.id), 3);
  assert.equal(counts.byPlateId.get(plate1.id), 1);
  assert.equal(counts.offPlate, 1);
  assert.equal(counts.byPlateId.has(OFF_PLATE_ID), false, 'the sentinel is never a tab');
});
