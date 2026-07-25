// scenario (g), step 2: with ui/index.ts present (a stray barrel), importing
// the SAME symbol via the barrel path (`../ui`, resolving to ui/index.ts)
// instead of the deep file path (`../ui/arrival-list`) is allowed. Swapped
// in for feat-checkin/feat-checkin.ts.
import { checkinStore } from '../data/checkin.store';
import { ArrivalList } from '../ui';
import { checkinDeskStore } from './data/checkin-desk.store';

export function FeatCheckin(): string {
  return [
    `open arrivals: ${checkinDeskStore.openArrivals}`,
    ...ArrivalList(checkinStore.all),
  ].join('\n');
}
