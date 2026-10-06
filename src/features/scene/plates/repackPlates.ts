import * as THREE from 'three';

import { beginSupportStateBatch, endSupportStateBatch, transformSupportsForModel } from '@/supports/state';

import { derivePlateOffset, plateOffsetsEqual, resolveModelPlateId } from './plateLayout';
import type { Plate, PlateBuildVolume, PlateOffsetMm } from './types';

/**
 * Plate repack (decision D6).
 *
 * Model transforms are world-space and already include their plate's offset
 * (D1). When the build volume changes — the user switches printer profile, or a
 * `.voxl` saved on a machine with a different printer is opened — every plate
 * from slot 1 onwards lands somewhere new, and its member models have to move
 * with it or they would be left sitting in the gap between plates.
 *
 * This is a consistency migration, not a user edit: callers must NOT push it
 * onto the history stack. Slot 0 is always at the origin, so a single-plate
 * project never repacks.
 *
 * Off-plate models are never moved. They are staged in world space and belong
 * to no plate, so no plate's offset change applies to them. This falls out of
 * `OFF_PLATE_ID` never being a key in `deltaByPlateId` rather than needing a
 * guard, and `offPlateModelsAreNeverRepacked` in the tests pins it.
 */

/** A model this module is allowed to move. Structural, to avoid importing the scene hook. */
export type RepackableModel = {
  id: string;
  plateId?: string;
  transform: {
    position: THREE.Vector3;
    rotation: THREE.Euler;
    scale: THREE.Vector3;
  };
};

export type RepackPlatesResult<TModel> = {
  /** Plates with `offsetMm` updated to the newly derived values. */
  plates: Plate[];
  /** Models, with members of moved plates translated. Same array when nothing moved. */
  models: TModel[];
  /** Number of models whose transform was rewritten. */
  movedModelCount: number;
  /** Plate ids whose offset changed. */
  movedPlateIds: string[];
};

function deltaFor(plate: Plate, buildVolume: PlateBuildVolume): PlateOffsetMm | null {
  const derived = derivePlateOffset(plate.slotIndex, buildVolume);
  if (plateOffsetsEqual(derived, plate.offsetMm)) return null;
  return { x: derived.x - plate.offsetMm.x, y: derived.y - plate.offsetMm.y };
}

/**
 * Translates every model (and its supports) belonging to a plate whose derived
 * offset no longer matches its recorded `offsetMm`, then records the new
 * offsets on the returned plates.
 *
 * Support translation reuses `transformSupportsForModel`, which already moves
 * roots, trunks, branches, knots, braces and kickstands for one model given a
 * before/after transform. The whole pass is wrapped in a single support-state
 * batch so subscribers see one update rather than one per model.
 */
export function repackPlates<TModel extends RepackableModel>(
  plates: readonly Plate[],
  models: readonly TModel[],
  buildVolume: PlateBuildVolume,
  activePlateId: string,
): RepackPlatesResult<TModel> {
  const deltaByPlateId = new Map<string, PlateOffsetMm>();
  for (const plate of plates) {
    const delta = deltaFor(plate, buildVolume);
    if (delta) deltaByPlateId.set(plate.id, delta);
  }

  if (deltaByPlateId.size === 0) {
    return {
      plates: plates as Plate[],
      models: models as TModel[],
      movedModelCount: 0,
      movedPlateIds: [],
    };
  }

  const nextPlates = plates.map((plate) => (
    deltaByPlateId.has(plate.id)
      ? { ...plate, offsetMm: derivePlateOffset(plate.slotIndex, buildVolume) }
      : plate
  ));

  let movedModelCount = 0;

  beginSupportStateBatch();
  try {
    const nextModels = models.map((model) => {
      const delta = deltaByPlateId.get(resolveModelPlateId(model, activePlateId));
      if (!delta) return model;

      const before = model.transform;
      const after = {
        position: before.position.clone().add(new THREE.Vector3(delta.x, delta.y, 0)),
        rotation: before.rotation.clone(),
        scale: before.scale.clone(),
      };

      // Supports store absolute world positions, so they move with the model.
      transformSupportsForModel(model.id, before, after);
      movedModelCount += 1;

      return { ...model, transform: after };
    });

    return {
      plates: nextPlates,
      models: nextModels,
      movedModelCount,
      movedPlateIds: [...deltaByPlateId.keys()],
    };
  } finally {
    endSupportStateBatch();
  }
}
