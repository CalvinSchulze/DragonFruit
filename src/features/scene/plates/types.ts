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
 *   3. every model resolves to an existing plate
 *   4. `slotIndex` is unique across plates
 *   5. a support's plate is implied by its model — supports never carry `plateId`
 *   6. plate offsets change only via `repackPlates`
 */

/** Gap between adjacent plates, in millimetres. */
export const PLATE_GAP_MM = 20;

/** Name given to the implicit first plate of a project. */
export const DEFAULT_PLATE_NAME = 'Plate 1';

/**
 * Hard cap on plate count. The data model is already N-plate capable; nothing
 * yet creates a second plate, so this stays at 1 until the plate operations and
 * UI land. Raising it is the switch that turns the feature on.
 */
export const MAX_PLATES = 1;

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
