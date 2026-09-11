"use client";

import { useCallback, useEffect, useRef, type ReactNode } from "react";

/**
 * A real dialog, not `window.confirm`: an irreversible action deserves text that says so,
 * a focus trap, an Escape key and a button the keyboard can reach.
 *
 * It confirms an *intent*. Whether the action is actually permitted is the API's answer, and
 * the caller renders that answer once it arrives.
 */
export interface ConfirmDialogProps {
  readonly titleId: string;
  readonly title: string;
  readonly children: ReactNode;
  readonly confirmLabel: string;
  /**
   * Decoration only, and never the thing that says what the button does: the label carries
   * that. It exists so an approval is not painted in the colour of a destructive action.
   */
  readonly confirmTone?: "danger" | "primary";
  readonly cancelLabel?: string;
  readonly busy?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

const FOCUSABLE = "button:not([disabled]), [href], input, select, textarea";

export function ConfirmDialog({
  titleId,
  title,
  children,
  confirmLabel,
  confirmTone = "danger",
  cancelLabel = "Voltar",
  busy = false,
  onConfirm,
  onCancel
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const openerRef = useRef<Element | null>(null);

  useEffect(() => {
    openerRef.current = document.activeElement;
    cancelRef.current?.focus();

    return () => {
      if (openerRef.current instanceof HTMLElement) {
        openerRef.current.focus();
      }
    };
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCancel();

        return;
      }

      if (event.key !== "Tab" || dialogRef.current === null) {
        return;
      }

      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)
      );
      const first = focusable.at(0);
      const last = focusable.at(-1);

      if (first === undefined || last === undefined) {
        return;
      }

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onCancel]
  );

  return (
    <div className="dialog-backdrop">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="dialog"
        onKeyDown={handleKeyDown}
      >
        <h2 id={titleId}>{title}</h2>
        {children}
        <div className="dialog-actions">
          <button
            type="button"
            ref={cancelRef}
            className="button button-secondary"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`button button-${confirmTone}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Processando..." : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
