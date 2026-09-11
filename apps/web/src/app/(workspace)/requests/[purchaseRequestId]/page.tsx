import { RequestDetail } from "@/purchase-requests/request-detail";

/** Next 15 hands route parameters to a page as a promise. */
export default async function RequestDetailPage({
  params
}: {
  readonly params: Promise<{ readonly purchaseRequestId: string }>;
}) {
  const { purchaseRequestId } = await params;

  return <RequestDetail purchaseRequestId={purchaseRequestId} />;
}
