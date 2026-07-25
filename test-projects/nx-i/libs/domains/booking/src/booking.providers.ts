import { BOOKING_API } from './api';
import { HttpBookingApi } from './infra/http-booking-api';

/** Slice root (entry, type:feature): wires the port contract to its impl. */
export function provideBooking(): void {
  BOOKING_API.impl = new HttpBookingApi();
}
