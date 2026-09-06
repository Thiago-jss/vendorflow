import { ApiProperty } from "@nestjs/swagger";
import type {
  PurchaseRequestApprovalQueueItem,
  PurchaseRequestApprovalQueuePage,
} from "../../../application/contracts/purchase-request-view";
import {
  ApprovalStepResponse,
  toApprovalStepResponse,
} from "./purchase-request-approval.response";
import {
  PurchaseRequestSummaryResponse,
  toPurchaseRequestSummaryResponse,
} from "./purchase-request.response";
import { encodePurchaseRequestCursor } from "./purchase-request-cursor";

/**
 * FR-030. A queue row: the request summary plus the step that is waiting on the caller.
 *
 * It lives in its own file rather than beside either half, because it is the only thing that
 * refers to both — putting it with one of them would make the two response modules import
 * each other, and a decorator evaluated during a module cycle sees `undefined` where it
 * expects a class.
 *
 * The row carries a summary, not the whole request: the justification and the item lines stay
 * out of a collection response, exactly as they do in the requester's own list.
 */
export class PurchaseRequestApprovalQueueItemResponse {
  @ApiProperty({ type: PurchaseRequestSummaryResponse })
  request!: PurchaseRequestSummaryResponse;

  @ApiProperty({ type: ApprovalStepResponse })
  pendingStep!: ApprovalStepResponse;
}

export class PurchaseRequestApprovalQueueResponse {
  @ApiProperty({ type: [PurchaseRequestApprovalQueueItemResponse] })
  items!: PurchaseRequestApprovalQueueItemResponse[];

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      "Opaque keyset cursor for the next page, or null on the last page. There is no total count.",
  })
  nextCursor!: string | null;
}

export function toPurchaseRequestApprovalQueueResponse(
  page: PurchaseRequestApprovalQueuePage,
): PurchaseRequestApprovalQueueResponse {
  return {
    items: page.items.map((item) => toQueueItemResponse(item)),
    nextCursor:
      page.nextCursor === null
        ? null
        : encodePurchaseRequestCursor(page.nextCursor),
  };
}

function toQueueItemResponse(
  item: PurchaseRequestApprovalQueueItem,
): PurchaseRequestApprovalQueueItemResponse {
  return {
    request: toPurchaseRequestSummaryResponse(item.request),
    pendingStep: toApprovalStepResponse(item.pendingStep),
  };
}
