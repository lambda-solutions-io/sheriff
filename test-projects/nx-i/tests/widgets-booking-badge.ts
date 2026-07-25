// scenario (h): a plain ui helper in a NEW sub-folder of the ui bucket.
// `libs/domains/booking/src/ui/widgets` is NOT covered by any `modules`
// pattern — the config only knows the buckets themselves. Copied in as
// ui/widgets/booking-badge.ts by integration-test.sh.
import { Booking } from '../../types/booking.model';

export function BookingBadge(booking: Booking): string {
  return `[${booking.status}]`;
}
