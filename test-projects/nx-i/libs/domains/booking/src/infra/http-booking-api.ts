import { BookingApi } from '../api';
import { Booking } from '../types/booking.model';

/**
 * The port's implementation (type:infra). Invisible outside this slice: the
 * bucket is not tagged `port`, so no foreign domain can reach it.
 */
export class HttpBookingApi implements BookingApi {
  async loadBookings(): Promise<Booking[]> {
    const response = await fetch('/api/bookings');
    return (await response.json()) as Booking[];
  }
}
