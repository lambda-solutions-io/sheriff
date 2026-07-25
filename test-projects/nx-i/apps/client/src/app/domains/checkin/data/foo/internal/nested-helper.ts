import { CheckinRecord } from '../../../types/checkin.model';

/**
 * NESTED `internal/` (data/foo/internal/, not data/internal/) — per
 * docs/architecture.md gotcha #4 in the source consumer repo, and per
 * https://github.com/lambda-solutions-io/sheriff/issues/31 finding 2:
 * Sheriff's encapsulation check only recognizes a TOP-LEVEL `internal/`
 * folder relative to the module root. `Module.exposes()` computes the
 * imported file's path relative to the MODULE it belongs to (here: `data`)
 * and checks `relativePath.startsWith('internal')` — for this file that
 * relative path is `foo/internal/nested-helper.ts`, which does NOT start
 * with `internal`, so the file is (surprisingly) considered PUBLIC. An
 * outside import of this file is currently silently allowed. See scenario
 * (f) in integration-test.sh, which pins down this exact behavior.
 */
export function describeNested(record: CheckinRecord): string {
  return `${record.guestName}#${record.id}`;
}
