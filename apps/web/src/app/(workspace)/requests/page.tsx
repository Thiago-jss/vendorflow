import Link from "next/link";
import { RequestList } from "@/purchase-requests/request-list";

export default function RequestsPage() {
  return (
    <section className="page">
      <div className="page-header">
        <div>
          <h1>Minhas solicitações de compra</h1>
          <p className="page-intro">
            Acompanhe suas solicitações, da mais recente para a mais antiga.
          </p>
        </div>
        <Link className="button button-primary" href="/requests/new">
          Nova solicitação
        </Link>
      </div>
      <RequestList />
    </section>
  );
}
