import { CHECKIN_API } from '../api/checkin-api';
import { CheckinRecord } from '../types/checkin.model';
import { toCheckinRecord } from './internal/checkin.mapper';
import { describeNested } from './foo/internal/nested-helper';

/** Domain-shared store: binds to the PORT, never to infra directly. */
export class CheckinStore {
  private records: CheckinRecord[] = [];

  get all(): CheckinRecord[] {
    return this.records;
  }

  async load(): Promise<void> {
    const dtos = (await CHECKIN_API.impl?.loadCheckins()) ?? [];
    this.records = dtos.map(toCheckinRecord);
  }

  describeFirst(): string {
    return this.records[0] ? describeNested(this.records[0]) : '(none)';
  }

  handle(bookingId: string, guestName: string): void {
    this.records.push({
      id: `c${this.records.length + 1}`,
      bookingId,
      guestName,
      checkedInAt: new Date().toISOString(),
    });
  }
}

export const checkinStore = new CheckinStore();
