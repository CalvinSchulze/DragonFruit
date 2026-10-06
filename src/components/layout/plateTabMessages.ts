/**
 * Translated plate-tab strings that interpolate a value.
 *
 * Module level on purpose: React Compiler renames locals inside components
 * (`count` -> `count_0`) before the Lingui macro derives the message id, so an
 * interpolation written inside `PlateTabStrip` gets an id the compiled
 * catalogue does not contain and falls back to the raw source string in
 * production builds. See `topBarMessages.ts` for the same pattern.
 */

import { msg, plural } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

type Translate = (descriptor: MessageDescriptor) => string;

/** Tooltip and screen-reader label for one plate tab. */
export function formatPlateTabLabel(
  plateName: string,
  modelCount: number,
  translate: Translate,
): string {
  return translate(msg`${plateName} — ${plural(modelCount, { one: '# model', other: '# models' })}`);
}

/** Tooltip on the add button once the plate cap is reached. */
export function formatPlateLimitReached(maxPlates: number, translate: Translate): string {
  return translate(msg`Plate limit reached (${maxPlates})`);
}
