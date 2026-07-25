// scenario (e): importing a file under a TOP-LEVEL `internal/` folder from
// outside the module that owns it (data/internal/checkin.mapper.ts, imported
// here from the slice root, not from within data/) -> encapsulation
// violation, even though the dependency-rule layer matrix (feature -> data)
// would otherwise allow the import. Swapped in for checkin.routes.ts.
import { provideCheckin } from './checkin.providers';
import { FeatCheckin } from './feat-checkin/feat-checkin';
import { FeatHistory } from './feat-history/feat-history';
import { toCheckinRecord } from './data/internal/checkin.mapper';

provideCheckin();

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _probe = toCheckinRecord;

export const checkinRoutes = [
  { path: 'checkin', handler: FeatCheckin },
  { path: 'checkin/history', handler: FeatHistory },
];
