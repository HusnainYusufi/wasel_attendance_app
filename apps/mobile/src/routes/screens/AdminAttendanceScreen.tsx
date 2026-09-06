import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  AttendanceSource,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  type AttendanceEntryDto,
  type UserDto,
} from '@wasel/contracts';
import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { adminApi, queryKeys } from '../../api';
import { LoadFailure } from '../../components/LoadFailure';
import {
  Badge,
  Button,
  Card,
  ClockIcon,
  EmptyState,
  Input,
  PlusIcon,
  Screen,
  SegmentedControl,
  Select,
  Skeleton,
  cx,
  type SegmentedOption,
} from '../../design';
import { AccountButton } from '../../features/account/AccountButton';
import {
  AttendanceEntrySheet,
  type AttendanceEntryTarget,
} from '../../features/admin/AttendanceEntrySheet';
import { useAuth } from '../../auth';
import {
  addDays,
  formatDuration,
  formatTime,
  formatWorkDate,
  isoDateIn,
  workDateDayNumber,
  workDateWeekday,
} from '../../lib/datetime';
import { paths } from '../paths';
import styles from './AdminAttendanceScreen.module.css';

const PAGE_SIZE = PAGE_SIZE_DEFAULT;
const ANY_PERSON = 'ALL';
const ANY_SOURCE = 'ALL';

type SourceFilter = AttendanceSource | typeof ANY_SOURCE;

const SOURCE_OPTIONS: ReadonlyArray<SegmentedOption<SourceFilter>> = [
  { value: ANY_SOURCE, label: 'All' },
  { value: AttendanceSource.PUNCH, label: 'Punched' },
  { value: AttendanceSource.MANUAL, label: 'By hand' },
];

/**
 * Manual attendance entry.
 *
 * The screen exists to make one thing visible before it makes anything editable:
 * which days were typed in by a person, and by whom. Every row states its
 * provenance — the manual ones carry a badge and the administrator's name, and
 * a filter narrows the list to them alone — because an attendance sheet whose
 * hand-entered rows look identical to punched ones is the failure this whole
 * feature is guarded against.
 */
export default function AdminAttendanceScreen() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const timezone = user?.timezone ?? 'UTC';

  // "Today" is the organization's, not the handset's: an administrator in London
  // correcting a Riyadh tenant must not be offered a window that has not started.
  const today = useMemo(() => isoDateIn(timezone), [timezone]);

  const [from, setFrom] = useState(() => addDays(today, -13));
  const [to, setTo] = useState(today);
  const [userId, setUserId] = useState<string>(ANY_PERSON);
  const [source, setSource] = useState<SourceFilter>(ANY_SOURCE);
  const [page, setPage] = useState(1);
  const [target, setTarget] = useState<AttendanceEntryTarget | null>(null);

  // Any filter change invalidates the page number — page 3 of the old result set
  // very likely does not exist in the new one. Adjusted during render, so no
  // request is ever issued for a page that is already stale.
  const filterKey = `${from}|${to}|${userId}|${source}`;
  const [appliedFilterKey, setAppliedFilterKey] = useState(filterKey);
  if (appliedFilterKey !== filterKey) {
    setAppliedFilterKey(filterKey);
    setPage(1);
  }

  const rangeValid = from !== '' && to !== '' && from <= to;

  const query = useMemo(
    () => ({
      from,
      to,
      page,
      pageSize: PAGE_SIZE,
      ...(userId === ANY_PERSON ? {} : { userId }),
      ...(source === ANY_SOURCE ? {} : { source }),
    }),
    [from, to, page, userId, source],
  );

  const people = useQuery({
    queryKey: queryKeys.admin.users({ pageSize: PAGE_SIZE_MAX }),
    queryFn: ({ signal }) => adminApi.listUsers({ pageSize: PAGE_SIZE_MAX }, signal),
  });

  const entries = useQuery({
    queryKey: queryKeys.admin.attendanceEntries(query),
    queryFn: ({ signal }) => adminApi.listAttendanceEntries(query, signal),
    enabled: rangeValid,
    // The previous page stays put while the next one loads, so nudging a date
    // does not flash an empty list between keystrokes.
    placeholderData: keepPreviousData,
  });

  const roster = people.data?.data ?? [];
  const rows = entries.data?.data ?? [];
  const meta = entries.data?.meta;
  const manualCount = rows.filter((row) => row.source === AttendanceSource.MANUAL).length;

  const openCreate = () =>
    setTarget({
      mode: 'create',
      people: roster,
      ...(userId === ANY_PERSON ? {} : { userId }),
    });

  const frame = (children: ReactNode) => (
    <Screen
      title="Attendance"
      eyebrow="Admin"
      subtitle="Record a day somebody could not punch, or correct one they got wrong."
      onBack={() => void navigate(paths.admin)}
      backLabel="Back to admin"
      action={<AccountButton />}
    >
      <div className={styles.filters}>
        <div className={styles.filterPair}>
          <Input
            label="From"
            type="date"
            value={from}
            max={to}
            onChange={(event) => setFrom(event.target.value)}
          />
          <Input
            label="To"
            type="date"
            value={to}
            min={from}
            onChange={(event) => setTo(event.target.value)}
          />
        </div>

        <Select
          label="Employee"
          value={userId}
          onChange={(event) => setUserId(event.target.value)}
          hint={people.isError ? 'The people list could not be loaded.' : undefined}
        >
          <option value={ANY_PERSON}>Everyone</option>
          {roster.map((person: UserDto) => (
            <option key={person.id} value={person.id}>
              {person.fullName}
            </option>
          ))}
        </Select>

        <SegmentedControl
          fullWidth
          label="How the day was recorded"
          value={source}
          onChange={setSource}
          options={SOURCE_OPTIONS}
        />
      </div>

      <Button
        fullWidth
        iconStart={<PlusIcon size="1.1rem" />}
        onClick={openCreate}
        disabled={people.isPending}
      >
        Record a day
      </Button>

      {rangeValid ? null : (
        <Card variant="outlined">
          <p className="u-body-sm">Choose a start date on or before the end date.</p>
        </Card>
      )}

      {children}

      <AttendanceEntrySheet target={target} timezone={timezone} onClose={() => setTarget(null)} />
    </Screen>
  );

  if (!rangeValid) return frame(null);

  if (entries.isPending) {
    return frame(
      <div className={styles.skeletonRows} aria-busy="true">
        <span className="u-visually-hidden">Loading attendance</span>
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton key={index} shape="rounded" height="4.5rem" />
        ))}
      </div>,
    );
  }

  if (entries.isError) {
    return frame(
      <LoadFailure
        error={entries.error}
        subject="this range of attendance"
        onRetry={() => void entries.refetch()}
      />,
    );
  }

  if (rows.length === 0) {
    return frame(
      <EmptyState
        icon={<ClockIcon size="1.65rem" />}
        title="Nothing recorded in this range"
        description={
          source === AttendanceSource.MANUAL
            ? 'No day in this window was entered by hand — every record here came from a real punch.'
            : 'Widen the dates, or record the day somebody could not punch.'
        }
        action={<Button onClick={openCreate}>Record a day</Button>}
      />,
    );
  }

  return frame(
    <>
      <p className={styles.resultRow} aria-live="polite">
        <span>
          {meta?.total ?? rows.length} {meta?.total === 1 ? 'day' : 'days'}
          {manualCount > 0 ? ` · ${manualCount} on this page entered by hand` : ''}
        </span>
        {entries.isFetching ? <span>Updating…</span> : null}
      </p>

      <Card padding="none">
        <ul className={styles.rows} role="list">
          {rows.map((entry) => (
            <li key={entry.id}>
              <EntryRow
                entry={entry}
                timezone={timezone}
                onEdit={() => setTarget({ mode: 'edit', entry })}
              />
            </li>
          ))}
        </ul>
      </Card>

      {meta && meta.totalPages > 1 ? (
        <div className={styles.pager}>
          <Button
            variant="secondary"
            size="sm"
            disabled={!meta.hasPrevious || entries.isFetching}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            Previous
          </Button>
          <span className={styles.pagerLabel}>
            Page {meta.page} of {meta.totalPages}
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={!meta.hasNext || entries.isFetching}
            onClick={() => setPage((current) => current + 1)}
          >
            Next
          </Button>
        </div>
      ) : null}
    </>,
  );
}

/**
 * One day, and — unmissably — whether a human typed it in.
 *
 * Hand-built rather than a `ListItem` because the provenance line must be able
 * to *wrap*: a reason is the whole point of a manual row, and the list item's
 * single clipped line would turn "Forgot to check out after the site visit"
 * into "Forgot to…", leaving the badge above it pointing at nothing.
 *
 * The badge carries a word, not only a colour, so it survives a colour-blind
 * reader and a phone in direct sun. It sits beside the name rather than in the
 * trailing column, because the trailing column holds the *status* and "Late"
 * and "By hand" answer completely different questions.
 *
 * A punched row deliberately has no third line. The asymmetry is the point:
 * hand-entered days are visibly taller and carry text nobody else's row does.
 */
function EntryRow({
  entry,
  timezone,
  onEdit,
}: {
  entry: AttendanceEntryDto;
  timezone: string;
  onEdit: () => void;
}) {
  const manual = entry.source === AttendanceSource.MANUAL;
  const out = entry.checkOutAt === null ? 'still open' : formatTime(entry.checkOutAt, timezone);

  return (
    <button type="button" className={cx(styles.row, manual && styles.manualRow)} onClick={onEdit}>
      <span className={styles.date} aria-hidden="true">
        <span className={styles.dateDay}>{workDateDayNumber(entry.workDate)}</span>
        <span className={styles.dateWeekday}>{workDateWeekday(entry.workDate)}</span>
      </span>

      <span className={styles.body}>
        <span className={styles.rowTitle}>
          <span className={styles.name}>{entry.userFullName}</span>
          {manual ? (
            <Badge tone="warning" size="sm">
              By hand
            </Badge>
          ) : null}
        </span>

        <span className={styles.times}>
          {/* The date block above is decorative; the row still has to say which
              day it is for anyone reading it with their ears. */}
          <span className="u-visually-hidden">{formatWorkDate(entry.workDate)}, </span>
          {formatTime(entry.checkInAt, timezone)} – {out}
          {entry.lateMinutes > 0 ? ` · ${formatDuration(entry.lateMinutes)} late` : ''}
        </span>

        {manual ? (
          <>
            <span className={styles.enteredBy}>
              {entry.enteredBy ? `Entered by ${entry.enteredBy.fullName}` : 'Entered by hand'}
            </span>
            {entry.note ? <span className={styles.provenance}>{entry.note}</span> : null}
          </>
        ) : null}
      </span>

      <span className={styles.worked}>{formatDuration(entry.workedMinutes)}</span>
    </button>
  );
}
