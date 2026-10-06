import { v4 as uuidv4 } from 'uuid';

import {
  DEFAULT_PLATE_NAME,
  PLATE_GAP_MM,
  type Plate,
  type PlateBuildVolume,
  type PlateOffsetMm,
} from './types';

/** Sub-micron tolerance for comparing recorded against derived offsets. */
const OFFSET_EPSILON_MM = 1e-6;

function sanitizeSpan(span: number): number {
  return Number.isFinite(span) && span > 0 ? span : 0;
}

/**
 * Plate layout is a single row along +X: slot 0 sits on the world origin and
 * each subsequent slot is one build volume plus a gap further along +X.
 */
export function derivePlateOffset(slotIndex: number, buildVolume: PlateBuildVolume): PlateOffsetMm {
  const slot = Number.isFinite(slotIndex) ? Math.max(0, Math.trunc(slotIndex)) : 0;
  const pitch = sanitizeSpan(buildVolume.widthMm) + PLATE_GAP_MM;
  return { x: slot * pitch, y: 0 };
}

/**
 * Lowest slot index not occupied by an existing plate. Deleting a plate frees
 * its slot so the next plate reclaims the hole rather than extending the row.
 */
export function lowestFreeSlotIndex(plates: readonly Plate[]): number {
  const taken = new Set<number>();
  for (const plate of plates) {
    if (Number.isFinite(plate.slotIndex)) taken.add(Math.trunc(plate.slotIndex));
  }

  let slot = 0;
  while (taken.has(slot)) slot += 1;
  return slot;
}

/** Default display name for a plate occupying `slotIndex`. */
export function defaultPlateName(slotIndex: number): string {
  const slot = Number.isFinite(slotIndex) ? Math.max(0, Math.trunc(slotIndex)) : 0;
  return slot === 0 ? DEFAULT_PLATE_NAME : `Plate ${slot + 1}`;
}

export function createPlate(slotIndex: number, buildVolume: PlateBuildVolume, name?: string): Plate {
  const slot = Number.isFinite(slotIndex) ? Math.max(0, Math.trunc(slotIndex)) : 0;
  const trimmedName = name?.trim();

  return {
    id: uuidv4(),
    name: trimmedName && trimmedName.length > 0 ? trimmedName : defaultPlateName(slot),
    slotIndex: slot,
    offsetMm: derivePlateOffset(slot, buildVolume),
  };
}

/**
 * The plate a model belongs to. A model without an explicit `plateId` (legacy
 * file, or a construction site that predates plates) falls back to the active
 * plate, so a model can never be orphaned.
 */
export function resolveModelPlateId(model: { plateId?: string }, activePlateId: string): string {
  return model.plateId ?? activePlateId;
}

export function plateOffsetsEqual(a: PlateOffsetMm, b: PlateOffsetMm): boolean {
  return Math.abs(a.x - b.x) <= OFFSET_EPSILON_MM && Math.abs(a.y - b.y) <= OFFSET_EPSILON_MM;
}

/**
 * True when any plate's recorded `offsetMm` no longer matches the offset
 * derived from the current build volume — i.e. the printer profile changed, or
 * the file was saved on a machine with a different build volume.
 */
export function platesNeedRepack(plates: readonly Plate[], buildVolume: PlateBuildVolume): boolean {
  return plates.some((plate) => !plateOffsetsEqual(plate.offsetMm, derivePlateOffset(plate.slotIndex, buildVolume)));
}
