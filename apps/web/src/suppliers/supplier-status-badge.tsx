/**
 * Whether the API reported this supplier active. The badge always carries the word, so the
 * distinction never depends on colour alone.
 */
export function SupplierStatusBadge({ isActive }: { readonly isActive: boolean }) {
  return (
    <span className="status-badge" data-status={isActive ? "ACTIVE" : "INACTIVE"}>
      {isActive ? "Ativo" : "Inativo"}
    </span>
  );
}
