// scenario (h): ui/booking-card.ts using a helper from its own ui bucket,
// one folder deeper. Copied over ui/booking-card.ts by integration-test.sh.
import { Booking } from '../types/booking.model';
import { BookingBadge } from './widgets/booking-badge';

/** Dumb ui function: types + utils only — NOT api, NOT data. */
export function BookingCard(booking: Booking): string {
  return `${booking.guestName} – ${booking.checkinDate} ${BookingBadge(booking)}`;
}
