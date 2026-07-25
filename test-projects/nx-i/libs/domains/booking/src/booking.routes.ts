import { provideBooking } from './booking.providers';
import { FeatCheckBooking } from './feat-check-booking/feat-check-booking';
import { FeatManageBooking } from './feat-manage-booking/feat-manage-booking';

provideBooking();

export const bookingRoutes = [
  { path: 'bookings', handler: FeatCheckBooking },
  { path: 'bookings/manage', handler: FeatManageBooking },
];
