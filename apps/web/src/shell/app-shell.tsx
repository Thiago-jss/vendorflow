"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { hasRole, roleLabel } from "@/session/current-context";
import { useSession } from "@/session/session-context";

/**
 * The authenticated chrome: where the user is, what they can open, and how to leave.
 *
 * The navigation is built from the roles `GET /me/organization` reported, and that is a
 * presentation decision only — a link that is absent is not a permission that is enforced.
 * Only routes this slice actually implements appear; approvals, suppliers, quotations and
 * purchase orders are not linked because they do not exist yet.
 */
export function AppShell({ children }: { readonly children: ReactNode }) {
  const { context, signOut } = useSession();
  const [leaving, setLeaving] = useState(false);

  if (context === null) {
    return <>{children}</>;
  }

  const { organization, membership } = context;
  const showRequests = hasRole(context, "EMPLOYEE");

  return (
    <div className="shell">
      <header className="shell-header">
        <div className="shell-identity">
          <p className="shell-organization">{organization.name}</p>
          <p className="shell-placement">
            {`${membership.branch.name} · ${membership.department.name}`}
          </p>
        </div>

        <nav aria-label="Seções">
          <ul className="shell-nav">
            {showRequests ? (
              <li>
                <Link href="/requests">Minhas solicitações</Link>
              </li>
            ) : null}
          </ul>
        </nav>

        <div className="shell-account">
          <p className="shell-session-label">Sessão ativa</p>
          <p className="shell-roles">
            {membership.roles.length === 0
              ? "Sem papéis atribuídos"
              : membership.roles.map((role) => roleLabel(role)).join(" · ")}
          </p>
          <button
            type="button"
            className="button button-secondary"
            disabled={leaving}
            onClick={() => {
              setLeaving(true);
              void signOut();
            }}
          >
            {leaving ? "Saindo..." : "Sair"}
          </button>
        </div>
      </header>

      <main className="shell-main">{children}</main>
    </div>
  );
}
