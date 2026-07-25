import { bookingStore } from '../data/booking.store';
import { BookingCard } from '../ui/booking-card';
import { checkBookingStore } from './data/check-booking.store';

/** Smart container: wires domain-shared + feat-private state into dumb ui. */
export function FeatCheckBooking(): string {
  return [
    ...bookingStore.all.map(BookingCard),
    `last confirmed: ${checkBookingStore.last ?? '(none)'}`,
  ].join('\n');
}
