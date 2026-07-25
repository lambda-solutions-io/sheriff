import { CheckinRecord } from '../types/checkin.model';
import { checkinLabel } from '../utils/checkin.utils';

/** Dumb ui function: types + utils only — NOT api, NOT data. */
export function ArrivalList(records: CheckinRecord[]): string[] {
  return records.map(checkinLabel);
}
