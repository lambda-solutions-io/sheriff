import { BOOKING_API } from '../api';
import { Booking } from '../types/booking.model';
import { isConfirmed } from '../utils/booking.utils';

/** Domain-shared store: binds to the PORT, never to infra directly. */
export class BookingStore {
  private bookings: Booking[] = [
    { id: 'b1', guestName: 'Ada Lovelace', checkinDate: '2026-08-01', status: 'pending' },
    { id: 'b2', guestName: 'Grace Hopper', checkinDate: '2026-08-03', status: 'confirmed' },
  ];

  get all(): Booking[] {
    return this.bookings;
  }

  get confirmed(): Booking[] {
    return this.bookings.filter(isConfirmed);
  }

  async load(): Promise<void> {
    this.bookings = (await BOOKING_API.impl?.loadBookings()) ?? this.bookings;
  }

  confirm(bookingId: string): void {
    this.bookings = this.bookings.map((b) =>
      b.id === bookingId ? { ...b, status: 'confirmed' as const } : b,
    );
  }
}

export const bookingStore = new BookingStore();
