import { v4 as uuidv4 } from 'uuid';

import {
  DEFAULT_PLATE_NAME,
  OFF_PLATE_ID,
  PLATE_GAP_MM,
  type Plate,
  type PlateBuildVolume,
  type PlateFootprintRect,
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
 *
 * `OFF_PLATE_ID` is returned as-is: it is a deliberate choice, not an absence,
 * so it never collapses to the active plate. Because it can never equal an
 * `activePlateId`, every active-plate filter excludes off-plate models for
 * free — which is what keeps them out of slicing and mesh export.
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

/**
 * A plate's printable area in plan view, in world millimetres.
 *
 * `offsetMm` is the plate's origin, and `originMode` says where the build
 * volume sits relative to it — the same `front_left ? 0 : -half` rule the view
 * settings use, in one place instead of restated per call site.
 */
export function plateFootprintRect(plate: Plate, buildVolume: PlateBuildVolume): PlateFootprintRect {
  const width = sanitizeSpan(buildVolume.widthMm);
  const depth = sanitizeSpan(buildVolume.depthMm);
  const frontLeft = buildVolume.originMode === 'front_left';
  const minX = plate.offsetMm.x + (frontLeft ? 0 : -width * 0.5);
  const minY = plate.offsetMm.y + (frontLeft ? 0 : -depth * 0.5);

  return { minX, minY, maxX: minX + width, maxY: minY + depth };
}

/**
 * Plan-view overlap test. Z is deliberately ignored: a model lifted or tilted
 * high above its plate still belongs to it, so plate membership is a question
 * about XY alone.
 */
function rectsOverlap(a: PlateFootprintRect, b: PlateFootprintRect, epsilonMm: number): boolean {
  return !(
    a.maxX < b.minX - epsilonMm
    || a.minX > b.maxX + epsilonMm
    || a.maxY < b.minY - epsilonMm
    || a.minY > b.maxY + epsilonMm
  );
}

/** Tolerance for plate membership. Matches the build-volume bounds epsilon. */
const PLATE_MEMBERSHIP_EPSILON_MM = 0.01;

/**
 * The plate a model's geometry puts it on, or `OFF_PLATE_ID` when its plan-view
 * bounds are disjoint from every plate.
 *
 * A model that merely straddles a plate edge still belongs to that plate —
 * overlap, not containment, is the test, so an oversized model is out of bounds
 * on its plate rather than homeless. Where footprints overlap (they should not,
 * given `PLATE_GAP_MM`) the lowest slot wins, so the result never depends on
 * array order.
 */
export function classifyModelPlate(
  modelBounds: PlateFootprintRect,
  plates: readonly Plate[],
  buildVolume: PlateBuildVolume,
  /**
   * Plate to keep the model on when it overlaps that one too — the plate it is
   * already on, or the active plate for a new model. Without it a model
   * overlapping two plates would snap to the lower slot, so nudging a model
   * could move it between plates.
   */
  preferPlateId?: string | null,
): string {
  let bestPlateId: string | null = null;
  let bestSlotIndex = Number.POSITIVE_INFINITY;

  for (const plate of plates) {
    if (!rectsOverlap(modelBounds, plateFootprintRect(plate, buildVolume), PLATE_MEMBERSHIP_EPSILON_MM)) continue;
    if (preferPlateId && plate.id === preferPlateId) return plate.id;
    if (plate.slotIndex < bestSlotIndex) {
      bestSlotIndex = plate.slotIndex;
      bestPlateId = plate.id;
    }
  }

  return bestPlateId ?? OFF_PLATE_ID;
}
