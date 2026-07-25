import { CheckinDto } from '../../api/checkin-api';
import { CheckinRecord } from '../../types/checkin.model';

/**
 * MODULE-PRIVATE (sheriff `encapsulationPattern: 'internal'`, the default):
 * a TOP-LEVEL `internal/` folder inside a module is only importable from
 * within that module (here: `data`). Even sibling modules of the same
 * domain get an encapsulation violation — no config or tag needed.
 */
export function toCheckinRecord(dto: CheckinDto): CheckinRecord {
  return {
    id: dto.id,
    bookingId: dto.booking_id,
    guestName: dto.guest_name,
    checkedInAt: dto.checked_in_at,
  };
}
