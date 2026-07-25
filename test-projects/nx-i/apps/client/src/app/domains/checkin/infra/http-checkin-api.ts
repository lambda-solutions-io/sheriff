import { CheckinApi, CheckinDto } from '../api/checkin-api';

/**
 * The port's implementation (type:infra) — the only place that knows the
 * backend exists. Not tagged `port`, so it is invisible to other domains.
 */
export class HttpCheckinApi implements CheckinApi {
  async loadCheckins(): Promise<CheckinDto[]> {
    const response = await fetch('/api/checkins');
    return (await response.json()) as CheckinDto[];
  }
}
