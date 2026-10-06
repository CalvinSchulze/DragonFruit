import {
  createPlate,
  defaultPlateName,
  lowestFreeSlotIndex,
  resolveModelPlateId,
} from './plateLayout';
import { MAX_PLATES, isOffPlate, type Plate, type PlateBuildVolume, type PlateOffsetMm } from './types';

/**
 * Plate set arithmetic: add, remove and rename, kept pure so the rules that
 * are easy to get wrong — slot reuse, tab order, which plate becomes active
 * after a delete, the "never delete the last plate" guard — are unit-testable
 * without a React tree.
 *
 * Nothing here touches models or supports. The scene hook owns that side:
 * these functions only ever answer "what does the plate set look like
 * afterwards?".
 */

/** Plates in tab order. */
export function sortPlatesBySlot(plates: readonly Plate[]): Plate[] {
  return [...plates].sort((a, b) => a.slotIndex - b.slotIndex);
}

/** Whether another plate may be created. */
export function canAddPlate(plates: readonly Plate[]): boolean {
  return plates.length < MAX_PLATES;
}

export type AddPlateResult = {
  /** The whole set, in tab order, with the new plate included. */
  plates: Plate[];
  /** The plate that was created. */
  plate: Plate;
};

/**
 * Appends a plate at the lowest free slot, or returns `null` at the cap.
 *
 * The lowest *free* slot rather than the next one along: deleting a plate
 * frees its slot, and reclaiming the hole keeps the row compact without ever
 * repacking — which would rewrite member transforms (D3).
 */
export function addPlateToSet(
  plates: readonly Plate[],
  buildVolume: PlateBuildVolume,
  name?: string,
): AddPlateResult | null {
  if (!canAddPlate(plates)) return null;

  const plate = createPlate(lowestFreeSlotIndex(plates), buildVolume, name);
  return { plates: sortPlatesBySlot([...plates, plate]), plate };
}

export type RemovePlateResult = {
  plates: Plate[];
  activePlateId: string;
  /** False when the request was refused — unknown id, or the last plate. */
  changed: boolean;
};

/**
 * Removes a plate and resolves which plate is active afterwards.
 *
 * Refuses to remove the last plate: a project always owns at least one
 * (invariant 1). Deleting the active plate activates the nearest survivor by
 * slot index, so focus lands on a neighbour rather than jumping to the start
 * of the row; ties go to the lower slot.
 */
export function removePlateFromSet(
  plates: readonly Plate[],
  activePlateId: string,
  plateId: string,
): RemovePlateResult {
  const target = plates.find((plate) => plate.id === plateId);
  const unchanged = { plates: plates as Plate[], activePlateId, changed: false };
  if (!target || plates.length <= 1) return unchanged;

  const remaining = sortPlatesBySlot(plates.filter((plate) => plate.id !== plateId));
  if (activePlateId !== plateId) {
    return { plates: remaining, activePlateId, changed: true };
  }

  const nearest = remaining.reduce((best, plate) => (
    Math.abs(plate.slotIndex - target.slotIndex) < Math.abs(best.slotIndex - target.slotIndex)
      ? plate
      : best
  ), remaining[0]);

  return { plates: remaining, activePlateId: nearest.id, changed: true };
}

/**
 * Renames a plate, or returns `null` when the request is a no-op — unknown id,
 * or a name that resolves to what the plate already has.
 *
 * A blank name falls back to the slot's default rather than being stored, so a
 * plate can never end up with an unclickable empty tab.
 */
export function renamePlateInSet(
  plates: readonly Plate[],
  plateId: string,
  name: string,
): Plate[] | null {
  const target = plates.find((plate) => plate.id === plateId);
  if (!target) return null;

  const trimmed = name.trim();
  const nextName = trimmed.length > 0 ? trimmed : defaultPlateName(target.slotIndex);
  if (nextName === target.name) return null;

  return plates.map((plate) => (plate.id === plateId ? { ...plate, name: nextName } : plate));
}

/**
 * A name for a copy of `plate` that no existing plate already uses. Plate names
 * are not required to be unique, but two identically named tabs are not worth
 * shipping when avoiding them costs a suffix.
 */
export function duplicatePlateName(plates: readonly Plate[], plate: Plate): string {
  const taken = new Set(plates.map((existing) => existing.name));

  const base = `${plate.name} Copy`;
  if (!taken.has(base)) return base;

  let suffix = 2;
  while (taken.has(`${base} ${suffix}`)) suffix += 1;
  return `${base} ${suffix}`;
}

/**
 * How far models have to move to go from `from`'s frame to `to`'s.
 *
 * Reads the *recorded* offsets, not derived ones: those are the offsets the
 * member transforms were actually written against (D3), and keeping the two
 * plates' records as the only input is what makes a duplicate land on its new
 * plate even when a repack is pending.
 */
export function plateOffsetDelta(from: Plate, to: Plate): PlateOffsetMm {
  return { x: to.offsetMm.x - from.offsetMm.x, y: to.offsetMm.y - from.offsetMm.y };
}

export type PlateModelCounts = {
  /** Model count per plate id. Plates with no models are absent. */
  byPlateId: Map<string, number>;
  /** Models staged on no plate at all. */
  offPlate: number;
};

/**
 * Model counts for the plate tabs. Counts every model in the project, not the
 * active plate's, which is the whole point of showing them on the tabs.
 */
export function countModelsByPlate(
  allModels: readonly { plateId?: string }[],
  activePlateId: string | null,
): PlateModelCounts {
  const byPlateId = new Map<string, number>();
  let offPlate = 0;

  for (const model of allModels) {
    const plateId = activePlateId ? resolveModelPlateId(model, activePlateId) : model.plateId;
    if (!plateId) continue;
    if (isOffPlate(plateId)) {
      offPlate += 1;
      continue;
    }
    byPlateId.set(plateId, (byPlateId.get(plateId) ?? 0) + 1);
  }

  return { byPlateId, offPlate };
}
