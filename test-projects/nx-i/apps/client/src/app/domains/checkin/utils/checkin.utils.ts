import { CheckinRecord } from '../types/checkin.model';

export function checkinLabel(record: CheckinRecord): string {
  return `${record.guestName} (${record.bookingId})`;
}
