import { checkinStore } from '../data/checkin.store';
// Sibling feat ONLY via its feat-port:
import { describeDesk } from '../feat-checkin/api/checkin-desk-api';

// scenario (d) violation variant swaps in an additional import here:
//   import { checkinDeskStore } from '../feat-checkin/data/checkin-desk.store';
// -> sibling feat internals, bypassing the feat-port. See
// tests/feat-history.port-bypass.ts and integration-test.sh scenario (d).

export function FeatHistory(): string {
  const deskStatus = describeDesk({ openArrivals: 0 });
  return [`desk: ${deskStatus}`, `checked in: ${checkinStore.all.length}`].join('\n');
}
