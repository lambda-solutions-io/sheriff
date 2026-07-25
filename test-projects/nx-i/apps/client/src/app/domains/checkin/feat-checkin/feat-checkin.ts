import { checkinStore } from '../data/checkin.store';
import { ArrivalList } from '../ui/arrival-list';
import { checkinDeskStore } from './data/checkin-desk.store';

/** Smart container: domain store + feat-private desk store + dumb ui. */
export function FeatCheckin(): string {
  return [
    `open arrivals: ${checkinDeskStore.openArrivals}`,
    ...ArrivalList(checkinStore.all),
  ].join('\n');
}
