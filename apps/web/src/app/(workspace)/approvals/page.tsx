import { ApprovalInbox } from "@/approvals/approval-inbox";

export default function ApprovalsPage() {
  return (
    <section className="page">
      <div className="page-header">
        <div>
          <h1>Aprovações pendentes</h1>
          <p className="page-intro">
            Solicitações enviadas no seu departamento que aguardam a sua decisão como gestor.
          </p>
        </div>
      </div>
      <ApprovalInbox />
    </section>
  );
}
