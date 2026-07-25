// scenario (f): importing a file under a NESTED `internal/` folder
// (data/foo/internal/nested-helper.ts — note: "foo/internal", NOT a
// top-level "internal") from OUTSIDE the module that (structurally) owns
// it. Per docs/architecture.md gotcha #4 in the source consumer repo and
// https://github.com/lambda-solutions-io/sheriff/issues/31 finding 2,
// Sheriff's encapsulation check only recognizes a TOP-LEVEL `internal/`
// folder relative to the module root — this import is CURRENTLY SILENTLY
// ALLOWED. This golden file pins down that (surprising) current behavior;
// it is expected to change to a violation if #31 finding 2 is ever fixed.
// Swapped in for checkin.routes.ts.
import { provideCheckin } from './checkin.providers';
import { FeatCheckin } from './feat-checkin/feat-checkin';
import { FeatHistory } from './feat-history/feat-history';
import { describeNested } from './data/foo/internal/nested-helper';

provideCheckin();

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _probe = describeNested;

export const checkinRoutes = [
  { path: 'checkin', handler: FeatCheckin },
  { path: 'checkin/history', handler: FeatHistory },
];
