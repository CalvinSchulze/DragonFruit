"use client";

import React from 'react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { Copy, Pencil, Plus, Trash2 } from 'lucide-react';

import { MAX_PLATES, sortPlatesBySlot, type Plate } from '@/features/scene/plates';
import { formatPlateLimitReached, formatPlateTabLabel } from '@/components/layout/plateTabMessages';

export type PlateTabStripProps = {
  plates: Plate[];
  activePlateId: string | null;
  /** Model count per plate id, from `scene.plateModelCounts.byPlateId`. */
  modelCountByPlateId: Map<string, number>;
  /** False once `MAX_PLATES` is reached. */
  canAddPlate: boolean;
  onSelectPlate: (plateId: string) => void;
  onAddPlate: () => void;
  onRenamePlate: (plateId: string, name: string) => void;
  onDuplicatePlate: (plateId: string) => void;
  onDeletePlate: (plateId: string) => void;
};

type ContextMenuState = {
  plateId: string;
  x: number;
  y: number;
};

const MENU_WIDTH_PX = 180;
/** Slightly over the rendered height, so the bottom clamp never cuts the menu off. */
const MENU_HEIGHT_PX = 152;

/**
 * The plate tab strip: one tab per build plate along the bottom of the
 * viewport, Lychee-style.
 *
 * Tabs are ordered by `slotIndex` rather than by array position, so reclaiming
 * a freed slot puts the new plate back where the deleted one was instead of at
 * the end of the row. Switching plates is a navigation action, so a tab is a
 * plain button; everything that changes the project sits behind the context
 * menu, where it cannot be hit by accident while clicking between plates.
 */
export function PlateTabStrip({
  plates,
  activePlateId,
  modelCountByPlateId,
  canAddPlate,
  onSelectPlate,
  onAddPlate,
  onRenamePlate,
  onDuplicatePlate,
  onDeletePlate,
}: PlateTabStripProps) {
  const { _ } = useLingui();
  const [contextMenu, setContextMenu] = React.useState<ContextMenuState | null>(null);
  const [renamingPlateId, setRenamingPlateId] = React.useState<string | null>(null);
  const [renamingName, setRenamingName] = React.useState('');

  const orderedPlates = React.useMemo(() => sortPlatesBySlot(plates), [plates]);
  const canDeletePlate = orderedPlates.length > 1;

  const closeContextMenu = React.useCallback(() => setContextMenu(null), []);

  React.useEffect(() => {
    if (!contextMenu) return undefined;

    const handlePointerDown = () => closeContextMenu();
    const handleEscape = (event: Event) => {
      if ((event as CustomEvent).detail?.key === 'Escape') closeContextMenu();
    };

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('app-hotkey-keydown', handleEscape);

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('app-hotkey-keydown', handleEscape);
    };
  }, [closeContextMenu, contextMenu]);

  const beginRename = (plate: Plate) => {
    setRenamingPlateId(plate.id);
    setRenamingName(plate.name);
    closeContextMenu();
  };

  const commitRename = () => {
    if (renamingPlateId) onRenamePlate(renamingPlateId, renamingName);
    setRenamingPlateId(null);
    setRenamingName('');
  };

  const cancelRename = () => {
    setRenamingPlateId(null);
    setRenamingName('');
  };

  const contextPlate = contextMenu
    ? orderedPlates.find((plate) => plate.id === contextMenu.plateId) ?? null
    : null;

  return (
    <>
      <div
        className="ui-panel pointer-events-auto flex max-w-[min(90vw,900px)] items-center gap-1 overflow-x-auto rounded-md px-1.5 py-1.5 shadow-md"
        style={{ background: 'color-mix(in srgb, var(--surface-0), transparent 8%)' }}
        role="tablist"
        aria-label={_(msg`Build plates`)}
      >
        {orderedPlates.map((plate) => {
          const isActive = plate.id === activePlateId;
          const modelCount = modelCountByPlateId.get(plate.id) ?? 0;
          const tabLabel = formatPlateTabLabel(plate.name, modelCount, _);

          if (plate.id === renamingPlateId) {
            return (
              <input
                key={plate.id}
                autoFocus
                className="ui-input h-7 w-32 shrink-0 rounded-md px-2 text-[12px]"
                value={renamingName}
                aria-label={_(msg`Plate name`)}
                onChange={(event) => setRenamingName(event.target.value)}
                onBlur={commitRename}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') commitRename();
                  if (event.key === 'Escape') cancelRename();
                }}
              />
            );
          }

          return (
            <button
              key={plate.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              title={tabLabel}
              aria-label={tabLabel}
              className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-[12px] font-medium transition-colors"
              style={{
                borderColor: isActive ? 'var(--accent)' : 'var(--border-subtle)',
                background: isActive
                  ? 'color-mix(in srgb, var(--accent), var(--surface-1) 78%)'
                  : 'var(--surface-1)',
                color: isActive ? 'var(--text-strong)' : 'var(--text-muted)',
              }}
              onClick={() => onSelectPlate(plate.id)}
              onDoubleClick={() => beginRename(plate)}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setContextMenu({ plateId: plate.id, x: event.clientX, y: event.clientY });
              }}
            >
              <span className="max-w-[140px] truncate">{plate.name}</span>
              <span
                className="rounded px-1 text-[10px] font-semibold tabular-nums"
                style={{
                  background: 'color-mix(in srgb, var(--surface-2), black 12%)',
                  color: 'var(--text-muted)',
                }}
              >
                {modelCount}
              </span>
            </button>
          );
        })}

        <button
          type="button"
          disabled={!canAddPlate}
          title={canAddPlate ? _(msg`Add plate`) : formatPlateLimitReached(MAX_PLATES, _)}
          aria-label={_(msg`Add plate`)}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border transition-colors disabled:opacity-40"
          style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}
          onClick={onAddPlate}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {contextMenu && contextPlate && (
        <div
          // `pointer-events-auto` is load-bearing: the strip is mounted inside a
          // `pointer-events-none` overlay so the viewport stays draggable around
          // it, and without this the menu renders but every click falls straight
          // through to the dismiss-on-pointerdown listener below.
          className="fixed z-[130] rounded-lg border p-1.5 shadow-xl pointer-events-auto"
          style={{
            width: MENU_WIDTH_PX,
            left: Math.max(8, Math.min(contextMenu.x, (typeof window !== 'undefined' ? window.innerWidth : 1920) - MENU_WIDTH_PX - 8)),
            top: Math.max(8, Math.min(contextMenu.y, (typeof window !== 'undefined' ? window.innerHeight : 1080) - MENU_HEIGHT_PX - 8)),
            borderColor: 'var(--border-subtle)',
            background: 'color-mix(in srgb, var(--surface-0), #000 12%)',
          }}
          onPointerDown={(event) => event.stopPropagation()}
          role="menu"
          aria-label={_(msg`Plate context menu`)}
        >
          <div
            className="mb-1 truncate px-2 py-1 text-[10px] font-semibold uppercase tracking-wide"
            style={{ color: 'var(--text-muted)' }}
          >
            {contextPlate.name}
          </div>

          <div className="space-y-0.5">
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium hover:bg-white/5"
              style={{ color: 'var(--text-strong)' }}
              onClick={() => beginRename(contextPlate)}
            >
              <Pencil className="h-3.5 w-3.5" />
              <span><Trans>Rename plate</Trans></span>
            </button>

            <button
              type="button"
              disabled={!canAddPlate}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium hover:bg-white/5 disabled:opacity-50"
              style={{ color: canAddPlate ? 'var(--text-strong)' : 'var(--text-muted)' }}
              title={canAddPlate ? undefined : formatPlateLimitReached(MAX_PLATES, _)}
              onClick={() => {
                onDuplicatePlate(contextPlate.id);
                closeContextMenu();
              }}
            >
              <Copy className="h-3.5 w-3.5" />
              <span><Trans>Duplicate plate</Trans></span>
            </button>

            <div className="my-1 h-px" style={{ background: 'var(--border-subtle)' }} />

            <button
              type="button"
              disabled={!canDeletePlate}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium hover:bg-white/5 disabled:opacity-50"
              style={{ color: canDeletePlate ? 'var(--danger)' : 'var(--text-muted)' }}
              title={canDeletePlate ? undefined : _(msg`A project always keeps at least one plate`)}
              onClick={() => {
                onDeletePlate(contextPlate.id);
                closeContextMenu();
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span><Trans>Delete plate</Trans></span>
            </button>
          </div>
        </div>
      )}
    </>
  );
}
