import { provideCheckin } from './checkin.providers';
import { FeatCheckin } from './feat-checkin/feat-checkin';
import { FeatHistory } from './feat-history/feat-history';

provideCheckin();

export const checkinRoutes = [
  { path: 'checkin', handler: FeatCheckin },
  { path: 'checkin/history', handler: FeatHistory },
];
