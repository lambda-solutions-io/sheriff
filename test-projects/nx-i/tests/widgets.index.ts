// scenario (h): the STRAY barrel of issue #31 finding 3. It sits in
// ui/widgets/, a directory NO `modules` pattern covers.
//
// With `moduleIdentity: 'auto'` (the default) this single file CREATES a
// brand-new, untagged (noTag) module, so ui/booking-card.ts suddenly
// imports across a module boundary instead of within its own module.
// With `moduleIdentity: 'config'` it creates nothing.
export { BookingBadge } from './booking-badge';
