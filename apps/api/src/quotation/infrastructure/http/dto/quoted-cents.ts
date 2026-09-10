import { parseCalendarDate } from "../../../../platform/calendar/calendar-date";
import { parseCents } from "../../../../platform/numeric/centavos";
import { SupplierQuoteValidationError } from "../../../application/contracts/quotation.errors";

/**
 * The HTTP boundary's parse of a monetary field, from the canonical digit string the DTO's
 * pattern already accepted into the `bigint` the domain works in.
 *
 * The DTO pattern refuses a malformed representation with 400; what is left for this to refuse
 * is a value that is well formed but larger than the system stores exactly — a technical
 * representation limit, so a stated domain answer (422) rather than a driver error.
 *
 * The field's *name* appears in the message; its value never does (SEC-009).
 */
export function parseQuotedCents(value: string, field: string): bigint {
  const parsed = parseCents(value);

  if (!parsed.ok) {
    throw new SupplierQuoteValidationError(
      parsed.reason === "malformed"
        ? `The ${field} is not a canonical integer amount in centavos`
        : `The ${field} is larger than this system stores exactly`,
    );
  }

  return parsed.value;
}

/**
 * BR-023's validity date. The DTO's pattern already refused anything that is not `YYYY-MM-DD`,
 * so what is left is a well-formed string that is not a real day — `2026-02-30` — which is a
 * domain refusal (422) rather than a malformed request.
 */
export function parseQuoteValidUntil(value: string): Date {
  const parsed = parseCalendarDate(value);

  if (parsed === null) {
    throw new SupplierQuoteValidationError(
      "The validity date is not a real calendar day",
    );
  }

  return parsed;
}
