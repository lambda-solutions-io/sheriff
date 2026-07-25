import { CHECKIN_API } from './api/checkin-api';
import { HttpCheckinApi } from './infra/http-checkin-api';

/**
 * Slice root (entry, type:feature): the ONLY place allowed to see both
 * api/ (port) and infra/ (impl) of THIS slice — that's what wires the
 * token to its implementation. A feat-<x>/ folder may not do this; only
 * the slice root, checked by file path (`inAnyFeat`) in sheriff.config.ts.
 */
export function provideCheckin(): void {
  CHECKIN_API.impl = new HttpCheckinApi();
}
