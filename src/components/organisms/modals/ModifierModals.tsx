import { AlertTriangle, Trash2 } from 'lucide-react';
import { StructuredDialogModal } from '@/components/ui/StructuredDialogModal';
import { useEscapeToClose } from '@/hotkeys/useEscapeToClose';
import { DestructiveTransformModal } from '@/components/modals/DestructiveTransformModal';
import { type HollowingPanelState } from '@/features/hollowing';

type PendingModifierResetAction = 'hollowing' | 'hole_punch' | 'clear_hollowing';

/** What the user chose in the unapplied-modifier prompt. The page performs the
 *  action — the modal only reports it. */
export type UnappliedModifierAction = 'apply' | 'skip' | 'goto';

export type UnappliedModifierPrompt = {
  title: string;
  subtitle: string;
  paragraphs: string[];
  /** Hidden when nothing has unapplied hole punches (nothing to bake). */
  showApplyAll: boolean;
};

export type ModifierModalsProps = {
  handleCancelDestructiveTransform: () => void;
  handleConfirmBlockerReset: () => void;
  handleConfirmDestructiveTransform: () => void;
  handleConfirmModifierReset: () => void;
  modifierApplyOverlayContent: { title: string; detailLines: string[]; };
  modifierApplyOverlayElapsedLabel: string;
  modifierApplyProcessingLabel: string;
  pendingBlockerResetState: HollowingPanelState | null;
  pendingDestructiveTransform: { modelId: string; modelName: string; supportCount: number; operationLabel: string; } | null;
  pendingModifierResetAction: PendingModifierResetAction | null;
  setPendingBlockerResetState: React.Dispatch<React.SetStateAction<HollowingPanelState | null>>;
  setPendingModifierResetAction: React.Dispatch<React.SetStateAction<PendingModifierResetAction | null>>;
  showModifierApplyBlockingOverlay: boolean;
  showUnappliedHolePunchModal: boolean;
  unappliedModifierPrompt: UnappliedModifierPrompt;
  unappliedHolePunchResolveRef: React.RefObject<((action: UnappliedModifierAction) => void) | null>;
};

/** Editor modal organism: StructuredDialog_unappliedHolePunch, StructuredDialog_modifierReset, StructuredDialog_blockerReset, DestructiveTransformModal, modifierApplyBlockingOverlay. */
export function ModifierModals({
  handleCancelDestructiveTransform,
  handleConfirmBlockerReset,
  handleConfirmDestructiveTransform,
  handleConfirmModifierReset,
  modifierApplyOverlayContent,
  modifierApplyOverlayElapsedLabel,
  modifierApplyProcessingLabel,
  pendingBlockerResetState,
  pendingDestructiveTransform,
  pendingModifierResetAction,
  setPendingBlockerResetState,
  setPendingModifierResetAction,
  showModifierApplyBlockingOverlay,
  showUnappliedHolePunchModal,
  unappliedModifierPrompt,
  unappliedHolePunchResolveRef,
}: ModifierModalsProps) {
  // A blocking progress overlay: swallow Escape rather than let it through.
  useEscapeToClose(showModifierApplyBlockingOverlay, undefined);

  return (
    <>
      <StructuredDialogModal
        open={showUnappliedHolePunchModal}
        ariaLabel="Unapplied model changes"
        title={unappliedModifierPrompt.title}
        subtitle={unappliedModifierPrompt.subtitle}
        icon={<AlertTriangle className="h-4 w-4" />}
        iconTone="warning"
        closeAriaLabel="Close"
        onClose={() => unappliedHolePunchResolveRef.current?.('skip')}
        actions={(
          <>
            <button
              type="button"
              className="ui-button ui-button-secondary !h-9 px-3 text-xs"
              onClick={() => unappliedHolePunchResolveRef.current?.('skip')}
            >
              Continue Without
            </button>
            <button
              type="button"
              className="ui-button !h-9 px-3 text-xs inline-flex items-center justify-center gap-1.5"
              style={{
                borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 45%)',
                background: 'color-mix(in srgb, var(--accent), var(--surface-1) 86%)',
                color: 'var(--accent)',
              }}
              onClick={() => unappliedHolePunchResolveRef.current?.('goto')}
            >
              Go to Hollow Tool
            </button>
            {unappliedModifierPrompt.showApplyAll && (
              <button
                type="button"
                className="ui-button !h-9 px-3 text-xs inline-flex items-center justify-center gap-1.5"
                style={{
                  borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 45%)',
                  background: 'color-mix(in srgb, var(--accent), var(--surface-1) 86%)',
                  color: 'var(--accent)',
                }}
                onClick={() => unappliedHolePunchResolveRef.current?.('apply')}
              >
                Apply to All
              </button>
            )}
          </>
        )}
      >
        <div className="space-y-2">
          {unappliedModifierPrompt.paragraphs.map((paragraph, index) => (
            <p
              key={index}
              className="text-xs leading-relaxed"
              style={{ color: 'var(--text-muted)' }}
            >
              {paragraph}
            </p>
          ))}
        </div>
      </StructuredDialogModal>

      <StructuredDialogModal
        open={pendingModifierResetAction !== null}
        ariaLabel="Confirm modifier reset"
        title={pendingModifierResetAction === 'hollowing' ? 'Remove Hollowing?' : 'Remove All Holes?'}
        subtitle="This action can't be undone"
        icon={<AlertTriangle className="h-4 w-4" />}
        iconTone="warning"
        closeAriaLabel="Close reset confirmation"
        onClose={() => setPendingModifierResetAction(null)}
        actions={(
          <>
            <button
              type="button"
              className="ui-button ui-button-secondary !h-9 px-3 text-xs"
              onClick={() => setPendingModifierResetAction(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="ui-button !h-9 px-3 text-xs inline-flex items-center justify-center gap-1.5"
              style={{
                borderColor: 'color-mix(in srgb, #ef4444, var(--border-subtle) 45%)',
                background: 'color-mix(in srgb, #ef4444, var(--surface-1) 86%)',
                color: 'var(--danger)',
              }}
              onClick={handleConfirmModifierReset}
            >
              <Trash2 className="w-3.5 h-3.5" />
              {pendingModifierResetAction === 'hollowing' ? 'Remove Hollowing' : 'Remove All Holes'}
            </button>
          </>
        )}
      >
        <div className="space-y-2">
          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            {pendingModifierResetAction === 'hollowing'
              ? 'Are you sure you want to remove hollowing from this model?'
              : 'Are you sure you want to remove all hole punches from this model?'}
          </p>
          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            {pendingModifierResetAction === 'hollowing'
              ? 'Your model will return to its solid version.'
              : 'All holes on this model will be removed.'}
          </p>
        </div>
      </StructuredDialogModal>

      <StructuredDialogModal
        open={pendingBlockerResetState !== null}
        ariaLabel="Confirm blocker reset"
        title="Reset Blockers?"
        subtitle="Blockers will be lost"
        icon={<AlertTriangle className="h-4 w-4" />}
        iconTone="warning"
        closeAriaLabel="Close blocker reset confirmation"
        onClose={() => setPendingBlockerResetState(null)}
        actions={(
          <>
            <button
              type="button"
              className="ui-button ui-button-secondary !h-9 px-3 text-xs"
              onClick={() => setPendingBlockerResetState(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="ui-button !h-9 px-3 text-xs inline-flex items-center justify-center gap-1.5"
              style={{
                borderColor: 'color-mix(in srgb, #ef4444, var(--border-subtle) 45%)',
                background: 'color-mix(in srgb, #ef4444, var(--surface-1) 86%)',
                color: 'var(--danger)',
              }}
              onClick={handleConfirmBlockerReset}
            >
              <Trash2 className="w-3.5 h-3.5" />
              Reset Blockers
            </button>
          </>
        )}
      >
        <div className="space-y-2">
          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            Changing the voxel resolution or shell thickness will clear all applied blockers.
          </p>
          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            You will need to re-select blocked regions after the change.
          </p>
        </div>
      </StructuredDialogModal>

      <DestructiveTransformModal
        isOpen={pendingDestructiveTransform !== null}
        modelName={pendingDestructiveTransform?.modelName ?? null}
        supportCount={pendingDestructiveTransform?.supportCount ?? 0}
        operationLabel={pendingDestructiveTransform?.operationLabel ?? 'Transform'}
        onCancel={handleCancelDestructiveTransform}
        onConfirm={handleConfirmDestructiveTransform}
      />

      {showModifierApplyBlockingOverlay && (
        <div className="absolute inset-0 z-[121] flex items-center justify-center bg-black/45 backdrop-blur-[1px]">
          <div
            className="w-[min(520px,92vw)] rounded-xl border px-5 py-4 shadow-xl"
            style={{
              background: 'color-mix(in srgb, var(--surface-0), black 10%)',
              borderColor: 'var(--border-subtle)',
            }}
            role="dialog"
            aria-modal="true"
            aria-live="polite"
          >
            <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
              {modifierApplyOverlayContent.title}
            </div>
            <div className="mt-1 space-y-0.5 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              {modifierApplyOverlayContent.detailLines.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>

            <div className="mt-2 text-[11px] font-medium tracking-wide" style={{ color: 'var(--accent)' }}>
              Elapsed: {modifierApplyOverlayElapsedLabel}
            </div>
            <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {modifierApplyProcessingLabel}
            </div>

            <div
              className="ui-loading-track mt-3 h-2.5 w-full rounded-full"
              style={{ background: 'color-mix(in srgb, var(--surface-2), black 20%)' }}
            >
              <div
                className="ui-loading-indicator"
                style={{ background: 'linear-gradient(90deg, var(--accent), #ff79c6)' }}
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
