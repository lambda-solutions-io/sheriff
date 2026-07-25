/** FEAT-PORT: the only module sibling feats may import from feat-checkin. */
export interface DeskSummary {
  openArrivals: number;
}

export function describeDesk(summary: DeskSummary): string {
  return summary.openArrivals === 0
    ? 'Desk clear — no open arrivals'
    : `${summary.openArrivals} open arrivals at the desk`;
}
