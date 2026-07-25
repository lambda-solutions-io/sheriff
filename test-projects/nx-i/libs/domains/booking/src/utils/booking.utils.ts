import { Booking } from '../types/booking.model';

export function isConfirmed(booking: Booking): boolean {
  return booking.status === 'confirmed';
}
