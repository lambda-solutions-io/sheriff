export type { CheckinRecord } from '../types/checkin.model';

/** Raw backend shape; mapped to the domain model in data/internal. */
export interface CheckinDto {
  id: string;
  booking_id: string;
  guest_name: string;
  checked_in_at: string;
}

/**
 * CONTRACT ONLY — the implementation (HttpCheckinApi, type:infra) is wired
 * at the slice root by provideCheckin(). Consumers bind to this interface,
 * so the HTTP client can be swapped or faked without touching a store.
 *
 * `type:api` has no clearance towards `type:infra`, so this file structurally
 * cannot name its own implementation — that is the inversion.
 */
export interface CheckinApi {
  loadCheckins(): Promise<CheckinDto[]>;
}

/** DI-token-ish container; wired by provideCheckin(). */
export const CHECKIN_API: { impl: CheckinApi | null } = { impl: null };
