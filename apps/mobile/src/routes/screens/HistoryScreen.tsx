import { useInfiniteQuery } from '@tanstack/react-query';
import { PAGE_SIZE_DEFAULT, formatDistance, type AttendanceRecordDto } from '@wasel/contracts';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { attendanceApi, queryKeys } from '../../api';
import { useAuth } from '../../auth';
import { LoadFailure } from '../../components/LoadFailure';
import { Button, Card, EmptyState, HistoryIcon, Screen, Skeleton, cx } from '../../design';
import { AccountButton } from '../../features/account/AccountButton';
import { StatusBadge } from '../../features/attendance/StatusBadge';
import {
  formatDuration,
  formatMonthLabel,
  formatTime,
  monthKey,
  workDateDayNumber,
  workDateWeekday,
} from '../../lib/datetime';
import styles from './HistoryScreen.module.css';

const PAGE_SIZE = PAGE_SIZE_DEFAULT;

interface MonthGroup {
  key: string;
  label: string;
  records: AttendanceRecordDto[];
  totalMinutes: number;
}

/**
 * Groups a flat, already-sorted page list into months.
 *
 * The API returns records newest first, so insertion order is preserved and a
 * `Map` is enough — sorting again here would risk disagreeing with the server
 * about ties and make the list reshuffle as pages arrive.
 */
function groupByMonth(records: readonly AttendanceRecordDto[]): MonthGroup[] {
  const groups = new Map<string, MonthGroup>();
  for (const record of records) {
    const key = monthKey(record.workDate);
    let group = groups.get(key);
    if (!group) {
      group = { key, label: formatMonthLabel(record.workDate), records: [], totalMinutes: 0 };
      groups.set(key, group);
    }
    group.records.push(record);
    group.totalMinutes += record.workedMinutes ?? 0;
  }
  return [...groups.values()];
}

export default function HistoryScreen() {
  const { user } = useAuth();
  const timezone = user?.timezone ?? 'UTC';
  const sentinelRef = useRef<HTMLDivElement>(null);

  const query = useInfiniteQuery({
    queryKey: queryKeys.attendance.history({ pageSize: PAGE_SIZE }),
    queryFn: ({ pageParam, signal }) =>
      attendanceApi.history({ page: pageParam, pageSize: PAGE_SIZE }, signal),
    initialPageParam: 1,
    // `hasNext` comes from the server's own page meta rather than being inferred
    // from a short page, which would stop one page early whenever the total is
    // an exact multiple of the page size.
    getNextPageParam: (last) => (last.meta.hasNext ? last.meta.page + 1 : undefined),
  });

  const records = useMemo(() => query.data?.pages.flatMap((page) => page.data) ?? [], [query.data]);
  const months = useMemo(() => groupByMonth(records), [records]);
  const total = query.data?.pages[0]?.meta.total ?? 0;

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;

  // Infinite scroll, with the explicit button below as the guaranteed fallback:
  // an IntersectionObserver never fires inside a container the user reaches by
  // keyboard alone, and some WebViews throttle it during momentum scrolling.
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasNextPage || isFetchingNextPage) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void fetchNextPage();
      },
      // Starts the next page a screenful early, so the list rarely stalls.
      { rootMargin: '400px 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const frame = (children: ReactNode) => (
    <Screen
      title="History"
      eyebrow={user?.organizationName}
      subtitle={
        query.isSuccess && total > 0
          ? `${total} ${total === 1 ? 'day' : 'days'} recorded, newest first.`
          : 'Your attendance, newest first.'
      }
      action={<AccountButton />}
    >
      {children}
    </Screen>
  );

  if (query.isPending) {
    return frame(
      <div className={styles.skeletonRows} aria-busy="true">
        <span className="u-visually-hidden">Loading your attendance history</span>
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} shape="rounded" height="4.25rem" />
        ))}
      </div>,
    );
  }

  if (query.isError) {
    return frame(
      <LoadFailure
        error={query.error}
        subject="your history"
        onRetry={() => void query.refetch()}
      />,
    );
  }

  if (records.length === 0) {
    return frame(
      <EmptyState
        icon={<HistoryIcon size="1.65rem" />}
        title="No attendance yet"
        description="Once you check in for the first time, every day you work will be listed here."
      />,
    );
  }

  return frame(
    <>
      {months.map((month) => (
        <section key={month.key} className={styles.month}>
          <header className={styles.monthHeader}>
            <h2 className={styles.monthTitle}>{month.label}</h2>
            <span className={styles.monthTotal}>
              {month.records.length} {month.records.length === 1 ? 'day' : 'days'} ·{' '}
              {formatDuration(month.totalMinutes)}
            </span>
          </header>

          <ul className={styles.rows}>
            {month.records.map((record) => (
              <li key={record.id}>
                <HistoryRow record={record} timezone={timezone} />
              </li>
            ))}
          </ul>
        </section>
      ))}

      <div ref={sentinelRef} aria-hidden="true" />

      {hasNextPage ? (
        <div className={styles.more}>
          <Button
            variant="secondary"
            loading={isFetchingNextPage}
            onClick={() => void fetchNextPage()}
          >
            {isFetchingNextPage ? 'Loading…' : 'Load older days'}
          </Button>
        </div>
      ) : null}
    </>,
  );
}

/**
 * Where the day was opened, and how far from the site that was.
 *
 * The distance is on every row rather than only on the far ones: it is what the
 * server actually recorded, and a number that appeared only when something was
 * "wrong" would turn a neutral fact into an accusation. Without a site there is
 * nothing to measure from, and saying so beats a blank that reads as a bug.
 */
function placeOf(record: AttendanceRecordDto): string {
  if (record.checkInSite === null) return 'No site configured';
  if (record.checkInDistanceM === null) return record.checkInSite.name;
  return `${record.checkInSite.name} · ${formatDistance(record.checkInDistanceM)}`;
}

/** Where the day was opened, and how late it started. */
function subtitleOf(record: AttendanceRecordDto): string {
  const late = record.lateMinutes > 0 ? ` · ${formatDuration(record.lateMinutes)} late` : '';
  return `${placeOf(record)}${late}`;
}

function HistoryRow({ record, timezone }: { record: AttendanceRecordDto; timezone: string }) {
  const checkOutAt = record.checkOutAt;

  return (
    <Card padding="sm">
      <div className={styles.row}>
        <div className={styles.date}>
          <span className={styles.dateDay}>{workDateDayNumber(record.workDate)}</span>
          <span className={styles.dateWeekday}>{workDateWeekday(record.workDate)}</span>
        </div>

        <div className={styles.body}>
          <span className={styles.times}>
            {formatTime(record.checkInAt, timezone)}
            {' → '}
            <span className={cx(checkOutAt === null && styles.open)}>
              {checkOutAt === null ? 'open' : formatTime(checkOutAt, timezone)}
            </span>
          </span>
          {/* One string for both the text and the tooltip: the line ellipses on a
              narrow screen, and a `title` that carried only half of it would drop
              exactly the part that got cut. */}
          <span className={styles.site} title={subtitleOf(record)}>
            {subtitleOf(record)}
          </span>
        </div>

        <div className={styles.trailing}>
          <span className={styles.worked}>{formatDuration(record.workedMinutes)}</span>
          <StatusBadge status={record.status} size="sm" />
        </div>
      </div>
    </Card>
  );
}
