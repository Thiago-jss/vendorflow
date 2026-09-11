"use client";

import type { ReactNode } from "react";
import type { ApiFailure } from "@/session/api-error";

/**
 * The three shapes every screen in this slice uses to say something went wrong, is loading,
 * or has nothing to show. They exist so no page invents its own way of announcing a failure
 * to a screen reader.
 */
export interface FailureAlertProps {
  readonly failure: ApiFailure;
  /** Shown for a mutation whose outcome the browser cannot know. */
  readonly ambiguous?: boolean;
  readonly onRetry?: () => void;
  readonly retryLabel?: string;
}

export function FailureAlert({
  failure,
  ambiguous = false,
  onRetry,
  retryLabel = "Tentar novamente"
}: FailureAlertProps) {
  return (
    <div role="alert" className="alert alert-error">
      <p className="alert-message">{failure.message}</p>
      {ambiguous ? (
        <p className="alert-note">
          Não é possível saber se a operação foi concluída. Recarregue a solicitação e
          confira o resultado antes de repetir a ação.
        </p>
      ) : null}
      {failure.details.length > 0 ? (
        <ul className="alert-details">
          {failure.details.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
      ) : null}
      {onRetry === undefined ? null : (
        <button type="button" className="button button-secondary" onClick={onRetry}>
          {retryLabel}
        </button>
      )}
    </div>
  );
}

export function LoadingRegion({ label }: { readonly label: string }) {
  return (
    <p className="loading" aria-busy="true">
      {label}
    </p>
  );
}

export function EmptyState({
  title,
  children
}: {
  readonly title: string;
  readonly children?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <p className="empty-state-title">{title}</p>
      {children}
    </div>
  );
}
