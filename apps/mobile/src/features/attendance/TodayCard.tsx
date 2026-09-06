import { formatDistance, type AttendanceRecordDto } from '@wasel/contracts';
import { Badge, Card, CardHeader } from '../../design';
import { formatDuration, formatTime, formatWorkDate } from '../../lib/datetime';
import { StatusBadge } from './StatusBadge';
import styles from '../../routes/screens/HomeScreen.module.css';

export interface TodayCardProps {
  record: AttendanceRecordDto;
  timezone: string;
  /** The work date the *server* considers current, for the overnight case. */
  currentWorkDate: string;
}

/**
 * Today's record, once one exists.
 *
 * The two punches sit side by side because that is the comparison being made —
 * "in at 08:57, out at 17:31" is one fact, not two. An open day shows an em dash
 * rather than a blank, so an unfinished day is visibly unfinished instead of
 * looking like a rendering failure.
 */
export function TodayCard({ record, timezone, currentWorkDate }: TodayCardProps) {
  // During an overnight shift the open record belongs to yesterday's work date.
  // Saying so is the difference between a clear screen and one that appears to
  // have the wrong date on it.
  const isCarriedOver = record.workDate !== currentWorkDate;

  return (
    <Card>
      <div className={styles.record}>
        <CardHeader
          title={isCarriedOver ? `Shift from ${formatWorkDate(record.workDate)}` : 'Today'}
          subtitle={record.checkInSite.name}
          action={<StatusBadge status={record.status} />}
        />

        <div className={styles.punchRow}>
          <div className={styles.punch}>
            <span className={styles.punchLabel}>Checked in</span>
            <span className={styles.punchTime}>{formatTime(record.checkInAt, timezone)}</span>
            <span className={styles.punchSite} title={record.checkInSite.name}>
              {record.checkInSite.name} · {formatDistance(record.checkInDistanceM)}
            </span>
          </div>

          <div className={styles.punch}>
            <span className={styles.punchLabel}>Checked out</span>
            <span className={styles.punchTime}>
              {record.checkOutAt ? formatTime(record.checkOutAt, timezone) : '—'}
            </span>
            <span className={styles.punchSite} title={record.checkOutSite?.name ?? ''}>
              {record.checkOutSite && record.checkOutDistanceM !== null
                ? `${record.checkOutSite.name} · ${formatDistance(record.checkOutDistanceM)}`
                : 'Still on the clock'}
            </span>
          </div>
        </div>

        <div className={styles.recordMeta}>
          <span>
            Worked{' '}
            <span className={styles.recordMetaValue}>
              {record.workedMinutes === null ? 'in progress' : formatDuration(record.workedMinutes)}
            </span>
          </span>
          {record.lateMinutes > 0 ? (
            <Badge tone="warning" variant="soft">
              {formatDuration(record.lateMinutes)} late
            </Badge>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
