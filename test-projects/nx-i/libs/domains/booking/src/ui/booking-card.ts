import { Booking } from '../types/booking.model';

/** Dumb ui function: types + utils only — NOT api, NOT data. */
export function BookingCard(booking: Booking): string {
  return `${booking.guestName} – ${booking.checkinDate} [${booking.status}]`;
}
