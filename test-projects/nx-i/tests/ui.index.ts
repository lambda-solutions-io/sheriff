// scenario (g): a STRAY `index.ts` appearing in a module of this
// barrel-less workspace (checkin/ui/, which normally has none) turns that
// module into a barrel module. Copied in as ui/index.ts by
// integration-test.sh. Re-exports the exact same symbol that
// ui/arrival-list.ts already exports.
export { ArrivalList } from './arrival-list';
