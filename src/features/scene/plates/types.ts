/**
 * Build volume plates ("plates") — data model.
 *
 * A project owns N plates; exactly one is active. Plates are laid out in a
 * single row along +X and a model's `transform` is always WORLD space, i.e. it
 * already includes its plate's offset (see `multi-volume-refactor.md` D1).
 *
 * Invariants enforced by the owning scene hook:
 *   1. `plates.length >= 1`
 *   2. `activePlateId` always resolves to an existing plate
 *   3. every model resolves to an existing plate, or is explicitly off-plate
 *      (`OFF_PLATE_ID`) — staged in world space on no plate at all
 *   4. `slotIndex` is unique across plates
 *   5. a support's plate is implied by its model — supports never carry `plateId`
 *   6. plate offsets change only via `repackPlates`
 *   7. an off-plate model is never moved by a repack and never sliced or
 *      mesh-exported, but is persisted, rendered and keeps its supports
 */

/** Gap between adjacent plates, in millimetres. */
export const PLATE_GAP_MM = 20;

/** Name given to the implicit first plate of a project. */
export const DEFAULT_PLATE_NAME = 'Plate 1';

/**
 * Hard cap on plate count, enforced by `addPlateToSet` and asserted by the
 * scene hook's dev-only invariants.
 *
 * The data model is N-plate capable, so the cap is a usability limit rather
 * than a structural one: plates occupy a single row along +X, so 16 of them on
 * a 220 mm printer already span ~3.8 m of world space, which is about as far as
 * the camera framing stays useful. A file that somehow carries more plates is
 * still read in full — the reader never drops plates — so the cap only bounds
 * what this app creates.
 */
export const MAX_PLATES = 16;

/** Offset of a plate's origin from the world origin, in millimetres. */
export type PlateOffsetMm = {
  x: number;
  y: number;
};

/**
 * The subset of the build volume that plate layout depends on. Kept structural
 * so both `View3DSettings` and printer-profile build volumes satisfy it.
 */
export type PlateBuildVolume = {
  widthMm: number;
  depthMm: number;
  /**
   * Where the build volume sits relative to its plate's origin. Only plate
   * footprints need this; `derivePlateOffset` depends on width alone. Optional
   * so the many callers that only drive layout stay unchanged, and defaults to
   * `'center'` to match `DEFAULT_VIEW_3D_SETTINGS`.
   */
  originMode?: 'center' | 'front_left';
};

export type Plate = {
  /** Stable identity; never reused. */
  id: string;
  /** User-editable display name. */
  name: string;
  /**
   * Permanent lattice slot assigned at creation. Deleting a plate frees its
   * slot; plates are never repacked on add/delete, so member model transforms
   * are never rewritten by normal editing.
   */
  slotIndex: number;
  /**
   * The offset that was in effect when the member transforms were written.
   * A mismatch against the derived offset means the build volume changed and
   * the plates need a repack.
   */
  offsetMm: PlateOffsetMm;
};

/**
 * The plate id of a model that is deliberately on no plate at all: it sits
 * somewhere in world space, staged rather than placed.
 *
 * Not a uuid, so it can never collide with a generated plate id, and
 * deliberately a non-empty string rather than `null` or `undefined`:
 *
 *   - the VOXL writers emit `plateId` with a truthiness guard, so a falsy
 *     sentinel would be dropped on save;
 *   - `undefined` already means "unstamped" — the legacy-file path that has to
 *     resolve to a real plate. Reusing it would put every pre-plates model off
 *     its plate.
 *
 * An off-plate model is persisted, rendered and keeps its supports, but is
 * never sliced or mesh-exported: those follow the active plate, and it is on
 * no plate. An older build reading the file sees an unknown plate id and
 * repairs the model onto plate 1, which is a valid scene rather than a loss.
 */
export const OFF_PLATE_ID = 'off-plate';

/** True when `plateId` names the off-plate bucket rather than a real plate. */
export function isOffPlate(plateId: string | null | undefined): boolean {
  return plateId === OFF_PLATE_ID;
}

/** A plan-view rectangle in world millimetres. */
export type PlateFootprintRect = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};
