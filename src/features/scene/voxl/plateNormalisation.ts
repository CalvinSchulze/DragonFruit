import { v4 as uuidv4 } from 'uuid';

import { isOffPlate } from '@/features/scene/plates';

import type { VoxlModelEntry, VoxlPlateEntry, VoxlSceneState } from './types';

/**
 * Plate normalisation for VOXL reads.
 *
 * Plates are an additive SCNE field, so every reader has to cope with three
 * cases: a file written before plates existed, a plate-bearing file, and a
 * plate-bearing file whose model→plate links are inconsistent (hand-edited,
 * truncated, or merged). After `normaliseVoxlPlates` the caller can assume:
 *
 *   - `plates.length >= 1`
 *   - `activePlateId` resolves to one of them
 *   - every model's `plateId` resolves to one of them, or is `OFF_PLATE_ID`
 *   - `slotIndex` is unique
 *
 * Offsets are deliberately *not* recomputed here. `offsetMm` records the offset
 * that was in effect when the member transforms were written, and the loader
 * compares it against the current build volume to decide whether to repack.
 * Rewriting it here would destroy exactly the information that decision needs.
 */

const LEGACY_PLATE_NAME = 'Plate 1';

/** Id for a plate synthesised while reading a file that predates plates. */
export function generateVoxlPlateId(): string {
  return uuidv4();
}

export type NormalisedVoxlPlates = {
  plates: VoxlPlateEntry[];
  activePlateId: string;
  /** True when the file carried no usable plate data and one was synthesised. */
  synthesised: boolean;
};

function isUsablePlate(value: unknown): value is VoxlPlateEntry {
  if (!value || typeof value !== 'object') return false;
  const plate = value as Partial<VoxlPlateEntry>;
  return typeof plate.id === 'string' && plate.id.length > 0;
}

function sanitisePlate(plate: VoxlPlateEntry, fallbackSlot: number): VoxlPlateEntry {
  const slotIndex = Number.isFinite(plate.slotIndex) ? Math.max(0, Math.trunc(plate.slotIndex)) : fallbackSlot;
  const offset = plate.offsetMm;
  const x = typeof offset?.x === 'number' && Number.isFinite(offset.x) ? offset.x : 0;
  const y = typeof offset?.y === 'number' && Number.isFinite(offset.y) ? offset.y : 0;

  return {
    id: plate.id,
    name: typeof plate.name === 'string' && plate.name.trim().length > 0
      ? plate.name
      : `Plate ${slotIndex + 1}`,
    slotIndex,
    offsetMm: { x, y },
  };
}

/**
 * Produces a valid plate set for a parsed scene, synthesising one plate at slot
 * 0 when the file predates plates. `makeId` is injected so the caller controls
 * id generation (and tests stay deterministic).
 */
export function normaliseVoxlPlates(
  scene: Pick<VoxlSceneState, 'plates' | 'activePlateId'> | null | undefined,
  makeId: () => string,
): NormalisedVoxlPlates {
  const raw = Array.isArray(scene?.plates) ? scene.plates.filter(isUsablePlate) : [];

  if (raw.length === 0) {
    const id = makeId();
    return {
      plates: [{ id, name: LEGACY_PLATE_NAME, slotIndex: 0, offsetMm: { x: 0, y: 0 } }],
      activePlateId: id,
      synthesised: true,
    };
  }

  // Drop duplicate ids (first wins) and force slotIndex uniqueness, so the
  // invariants downstream code relies on cannot be violated by a bad file.
  const seenIds = new Set<string>();
  const takenSlots = new Set<number>();
  const plates: VoxlPlateEntry[] = [];

  for (const candidate of raw) {
    if (seenIds.has(candidate.id)) continue;
    seenIds.add(candidate.id);

    const sanitised = sanitisePlate(candidate, plates.length);
    let slotIndex = sanitised.slotIndex;
    while (takenSlots.has(slotIndex)) slotIndex += 1;
    takenSlots.add(slotIndex);

    plates.push(slotIndex === sanitised.slotIndex ? sanitised : { ...sanitised, slotIndex });
  }

  const activePlateId = typeof scene?.activePlateId === 'string'
    && plates.some((plate) => plate.id === scene.activePlateId)
    ? scene.activePlateId
    : plates[0].id;

  return { plates, activePlateId, synthesised: false };
}

/**
 * Reassigns any model whose `plateId` is missing or dangling to the first
 * plate. Returns the same array instance when nothing needed fixing, so the
 * common path allocates nothing.
 *
 * `OFF_PLATE_ID` is preserved. It is a deliberate state — the model is staged
 * in world space on no plate — not a broken link, and repairing it onto plate 1
 * would silently move the model onto a plate the user took it off. A dangling
 * uuid is still repaired: that one really is a broken link.
 */
export function reassignOrphanedModelPlates(
  models: VoxlModelEntry[],
  plates: readonly VoxlPlateEntry[],
): VoxlModelEntry[] {
  if (plates.length === 0) return models;

  const known = new Set(plates.map((plate) => plate.id));
  const fallbackId = plates[0].id;

  let changed = false;
  const next = models.map((model) => {
    if (isOffPlate(model.plateId)) return model;
    if (model.plateId && known.has(model.plateId)) return model;
    changed = true;
    return { ...model, plateId: fallbackId };
  });

  return changed ? next : models;
}
