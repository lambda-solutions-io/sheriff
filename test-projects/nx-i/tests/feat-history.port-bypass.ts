// scenario (d): cross-slice import bypassing the public port — a sibling
// feat (feat-history) reaching directly into feat-checkin/data/, instead of
// going through feat-checkin's feat-port (feat-checkin/api/). Swapped in for
// feat-history/feat-history.ts by integration-test.sh.
import { checkinStore } from '../data/checkin.store';
import { describeDesk } from '../feat-checkin/api/checkin-desk-api';
// Bypasses the feat-port:
import { checkinDeskStore } from '../feat-checkin/data/checkin-desk.store';

export function FeatHistory(): string {
  const deskStatus = describeDesk({ openArrivals: checkinDeskStore.openArrivals });
  return [`desk: ${deskStatus}`, `checked in: ${checkinStore.all.length}`].join('\n');
}
