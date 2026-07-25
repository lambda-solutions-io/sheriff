// scenario (c): a `type:api` file importing `type:infra` — the port/infra
// inversion must be structural, not just discipline. Swapped in for
// api/checkin-api.ts by integration-test.sh.
import { HttpCheckinApi } from '../infra/http-checkin-api';

export type { CheckinRecord } from '../types/checkin.model';

export interface CheckinDto {
  id: string;
  booking_id: string;
  guest_name: string;
  checked_in_at: string;
}

export interface CheckinApi {
  loadCheckins(): Promise<CheckinDto[]>;
}

// The port naming its own impl — this is exactly what `type:api` having no
// clearance towards `type:infra` is meant to prevent.
export const CHECKIN_API: { impl: CheckinApi | null } = { impl: new HttpCheckinApi() };
