import { AttendanceStatus } from '@wasel/contracts';
import { Badge, type BadgeTone } from '../../design';

const TONE: Record<AttendanceStatus, BadgeTone> = {
  [AttendanceStatus.PRESENT]: 'success',
  [AttendanceStatus.LATE]: 'warning',
  [AttendanceStatus.INCOMPLETE]: 'neutral',
};

/**
 * `INCOMPLETE` is shown as "Open", not as the raw enum word: "incomplete" reads
 * as a fault the employee committed, when in fact it is a plain statement that
 * the day has not been closed yet — and for anyone still at their desk it is the
 * normal state. "Open" is also short enough to survive a 360px row without
 * squeezing the times beside it.
 */
const LABEL: Record<AttendanceStatus, string> = {
  [AttendanceStatus.PRESENT]: 'Present',
  [AttendanceStatus.LATE]: 'Late',
  [AttendanceStatus.INCOMPLETE]: 'Open',
};

export interface StatusBadgeProps {
  status: AttendanceStatus;
  size?: 'sm' | 'md';
}

/**
 * One vocabulary for attendance status across every screen.
 *
 * The dot never carries the meaning on its own — the word is always present — so
 * the badge survives a colour-blind reader and a phone screen in direct sun.
 */
export function StatusBadge({ status, size = 'md' }: StatusBadgeProps) {
  return (
    <Badge tone={TONE[status]} size={size} dot>
      {LABEL[status]}
    </Badge>
  );
}
