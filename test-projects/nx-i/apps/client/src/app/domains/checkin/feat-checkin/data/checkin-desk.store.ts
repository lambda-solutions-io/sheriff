import { checkinStore } from '../../data/checkin.store';
// Foreign domain (a DIFFERENT app/lib pair) ONLY via its public port —
// identical rule whether that domain lives app-internally or as a lib.
// The port is a contract: this store cannot see booking's HTTP client,
// which lives in booking/infra and carries no `port` tag.
import { Booking } from '@demo/booking/api';

/** Feat-private store: orchestrates the desk — arrivals in, check-ins out. */
export class CheckinDeskStore {
  private arrivals = 2;

  get openArrivals(): number {
    return this.arrivals;
  }

  checkIn(booking: Booking): void {
    checkinStore.handle(booking.id, booking.guestName);
    this.arrivals = Math.max(0, this.arrivals - 1);
  }
}

export const checkinDeskStore = new CheckinDeskStore();
