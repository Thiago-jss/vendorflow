import { EditRequestScreen } from "@/purchase-requests/edit-request-screen";

export default async function EditRequestPage({
  params
}: {
  readonly params: Promise<{ readonly purchaseRequestId: string }>;
}) {
  const { purchaseRequestId } = await params;

  return <EditRequestScreen purchaseRequestId={purchaseRequestId} />;
}
