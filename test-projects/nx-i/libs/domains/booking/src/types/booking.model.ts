export interface Booking {
  id: string;
  guestName: string;
  checkinDate: string;
  status: 'pending' | 'confirmed' | 'checked-in';
}
