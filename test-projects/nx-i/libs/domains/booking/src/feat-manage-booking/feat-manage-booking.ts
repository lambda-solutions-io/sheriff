import { bookingStore } from '../data/booking.store';
// Sibling feat ONLY via its feat-port:
import { describeCheck } from '../feat-check-booking/api/check-booking-api';
import { BookingCard } from '../ui/booking-card';

export function FeatManageBooking(): string {
  const lastCheck = describeCheck({ bookingId: 'b2', checkedAt: new Date().toISOString() });
  return [...bookingStore.confirmed.map(BookingCard), lastCheck].join('\n');
}
