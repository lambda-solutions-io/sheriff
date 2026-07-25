/**
 * PUBLIC PORT of the booking domain: the only module other domains may
 * import. This IS a real `index.ts` barrel — deliberately, at the BUCKET
 * level (`api/index.ts`), which is the one place a barrel is allowed and
 * expected even in an `enableBarrelLess: true` workspace: the wildcard
 * tsconfig path alias (`@demo/booking/*`) resolves `@demo/booking/api`
 * straight onto this file because TypeScript resolves a bare directory
 * import to its `index.ts`. It satisfies the "at least one real barrel
 * file inside a barrel-less workspace" requirement for this test project
 * — see also scenario (g) for the STRAY-barrel case, which is a barrel
 * appearing somewhere it should NOT (ui/), not this deliberate one.
 *
 * CONTRACT ONLY — no implementation. The HTTP client lives in infra/ and
 * is wired at the slice root by provideBooking().
 */
export type { Booking } from '../types/booking.model';

export interface BookingApi {
  loadBookings(): Promise<import('../types/booking.model').Booking[]>;
}

export const BOOKING_API: { impl: BookingApi | null } = { impl: null };
