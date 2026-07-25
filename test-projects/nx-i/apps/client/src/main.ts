// root (tag `root`): only composes slices via their entry file.
import { checkinRoutes } from './app/domains/checkin/checkin.routes';
import { bookingRoutes } from '@demo/booking/booking.routes';

export const routes = [...checkinRoutes, ...bookingRoutes];
