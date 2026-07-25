/**
 * FEAT-PORT: the only module sibling feats may import from
 * feat-check-booking. Never visible outside the booking domain.
 */
export interface CheckSummary {
  bookingId: string;
  checkedAt: string;
}

export function describeCheck(summary: CheckSummary): string {
  return `Booking ${summary.bookingId} checked at ${summary.checkedAt}`;
}
