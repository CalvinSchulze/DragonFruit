import * as THREE from 'three';

import { computeApproxModelWorldBounds } from '@/utils/modelBounds';

import { classifyModelPlate, resolveModelPlateId } from './plateLayout';
import { isOffPlate, type Plate, type PlateBuildVolume, type PlateFootprintRect } from './types';

/**
 * Plate assignment policy: where a model's geometry says it belongs.
 *
 * Structural model type, like `RepackableModel`, so the policy stays pure and
 * testable instead of importing the scene hook.
 */
export type PlateAssignableModel = {
  id: string;
  plateId?: string;
  geometry: {
    geometry: THREE.BufferGeometry;
    bbox: THREE.Box3;
    center: THREE.Vector3;
  };
  transform: {
    position: THREE.Vector3;
    rotation: THREE.Euler;
    scale: THREE.Vector3;
  };
};

export type PlateAssignmentState = {
  plates: readonly Plate[];
  activePlateId: string | null;
  buildVolume: PlateBuildVolume;
};

/** Sub-micron tolerance, matching the scene's own transform equality. */
const TRANSFORM_EPSILON = 1e-5;

function transformsEqual(
  a: PlateAssignableModel['transform'],
  b: PlateAssignableModel['transform'],
): boolean {
  return a.position.distanceToSquared(b.position) <= TRANSFORM_EPSILON
    && Math.abs(a.rotation.x - b.rotation.x) <= TRANSFORM_EPSILON
    && Math.abs(a.rotation.y - b.rotation.y) <= TRANSFORM_EPSILON
    && Math.abs(a.rotation.z - b.rotation.z) <= TRANSFORM_EPSILON
    && a.scale.distanceToSquared(b.scale) <= TRANSFORM_EPSILON;
}

/**
 * A model's plan-view extent in world millimetres.
 *
 * Approximate bounds on purpose: `computeApproxModelWorldBounds` transforms the
 * bounding box, which overestimates for a rotated model. For plate membership
 * that errs toward *keeping* a model on its plate, which is the safe direction
 * — the costly mistake is silently unassigning something.
 */
export function modelFootprintRect(model: PlateAssignableModel): PlateFootprintRect {
  const bounds = computeApproxModelWorldBounds(model.geometry, model.transform);
  return { minX: bounds.min.x, minY: bounds.min.y, maxX: bounds.max.x, maxY: bounds.max.y };
}

/**
 * Decides each model's plate from where it actually sits, at the two moments
 * where that can change:
 *
 *   - **a model with no `plateId`** — a fresh import. It lands on the plate its
 *     geometry overlaps, preferring the active one, and goes off-plate when it
 *     overlaps none. This is what handles an importer that hands us raw world
 *     coordinates: the LYS plugin replays a Lychee project's authored positions
 *     verbatim, so a multi-plate project arrives with most models hundreds of
 *     mm from the only plate. Those are staged off-plate rather than stamped
 *     onto a plate they are nowhere near.
 *   - **a model whose transform changed** — a committed move. Dragging a model
 *     clear of every plate stages it; dragging it back onto one re-adopts it.
 *     `preferPlateId` keeps it on the plate it is already on whenever that
 *     still overlaps, so a nudge never shuffles it between plates.
 *
 * Every other write (visibility, colour, name, selection) leaves `plateId`
 * alone — including `OFF_PLATE_ID`, which is a decision rather than an absence.
 * A model whose id is absent from `previous` is new, so a `plateId` loaded from
 * a file is honoured and `repackPlates` keeps ownership of the build-volume
 * case. Returns `models` unchanged when nothing moved, preserving referential
 * equality.
 */
export function assignModelPlates<TModel extends PlateAssignableModel>(
  models: TModel[],
  previous: readonly TModel[],
  state: PlateAssignmentState,
): TModel[] {
  const { plates, activePlateId, buildVolume } = state;
  if (!activePlateId || plates.length === 0) return models;

  const previousById = new Map(previous.map((model) => [model.id, model]));

  let changed = false;
  const assigned = models.map((model) => {
    const before = previousById.get(model.id);

    if (!model.plateId) {
      changed = true;
      return {
        ...model,
        plateId: classifyModelPlate(modelFootprintRect(model), plates, buildVolume, activePlateId),
      };
    }

    if (!before || transformsEqual(before.transform, model.transform)) return model;

    const currentPlateId = resolveModelPlateId(model, activePlateId);
    const nextPlateId = classifyModelPlate(
      modelFootprintRect(model),
      plates,
      buildVolume,
      isOffPlate(currentPlateId) ? null : currentPlateId,
    );
    if (nextPlateId === currentPlateId) return model;

    changed = true;
    return { ...model, plateId: nextPlateId };
  });

  return changed ? assigned : models;
}
