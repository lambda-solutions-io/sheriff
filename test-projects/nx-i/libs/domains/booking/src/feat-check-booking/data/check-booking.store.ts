import { bookingStore } from '../../data/booking.store';

/** Feat-private store; may use domain-shared data (same slice family). */
export class CheckBookingStore {
  private lastCheckedId: string | null = null;

  get last(): string | null {
    return this.lastCheckedId;
  }

  confirm(bookingId: string): void {
    this.lastCheckedId = bookingId;
    bookingStore.confirm(bookingId);
  }
}

export const checkBookingStore = new CheckBookingStore();
