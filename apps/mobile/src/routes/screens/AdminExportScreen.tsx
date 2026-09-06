import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import {
  EXPORT_MAX_RANGE_DAYS,
  EXPORT_VARIANT_COLUMNS,
  ExportFormat,
  ExportVariant,
  PAGE_SIZE_MAX,
  inclusiveDayCount,
  type ExportQuery,
  type UserDto,
} from '@wasel/contracts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { adminApi, isOffline, queryKeys, toDisplayMessage } from '../../api';
import { useAuth } from '../../auth';
import { Banner } from '../../components/Banner';
import { LoadFailure } from '../../components/LoadFailure';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  DownloadIcon,
  Input,
  Screen,
  SegmentedControl,
  Select,
  Skeleton,
  Spinner,
} from '../../design';
import { AccountButton } from '../../features/account/AccountButton';
import { SaveFileError, saveFile, type SaveOutcome } from '../../features/download/saveFile';
import {
  addDays,
  endOfMonth,
  formatDateRange,
  formatDuration,
  isoDateIn,
  previousMonthRange,
  startOfMonth,
} from '../../lib/datetime';
import styles from './AdminExportScreen.module.css';

const ALL_PEOPLE = 'ALL';

/**
 * What each sheet is *for*, in the words of the person choosing it.
 *
 * The column list below says what is in the file; this says why you would want
 * it. Together they are the whole reason the picker exists — the alternative is
 * finding out after a multi-second export, a download and an open, and then doing
 * it again.
 */
const VARIANT_COPY: Record<ExportVariant, { label: string; meta: string; purpose: string }> = {
  [ExportVariant.DETAILED]: {
    label: 'Detailed',
    meta: `${EXPORT_VARIANT_COLUMNS[ExportVariant.DETAILED].length} columns`,
    purpose:
      'Everything recorded about each day — where each punch happened, how far from the site, how accurate the fix was, and whether it fell outside the geofence.',
  },
  [ExportVariant.MINIFIED]: {
    label: 'Minified',
    meta: `${EXPORT_VARIANT_COLUMNS[ExportVariant.MINIFIED].length} columns`,
    purpose:
      'The payroll extract: who, which day, in, out and total hours. Nothing else, so there is nothing else to read by mistake.',
  },
};

/**
 * The one thing about a column that is not obvious from its name.
 *
 * Hours are a decimal rather than `8:16` so the column can be multiplied by a
 * rate and summed — in a CSV `8:16` is not a duration to a spreadsheet, it is a
 * time of day, and a column of them totals to a fifth of the truth.
 */
const VARIANT_NOTE: Record<ExportVariant, string | null> = {
  [ExportVariant.DETAILED]: null,
  [ExportVariant.MINIFIED]:
    'Total hours is a decimal — 8.27 means 8 h 16 m — and stays a real number in Excel, so selecting the column gives you a total.',
};

type Preset = 'this-month' | 'last-month' | 'last-7' | 'last-30' | 'custom';

const PRESET_LABEL: Record<Preset, string> = {
  'this-month': 'This month',
  'last-month': 'Last month',
  'last-7': 'Last 7 days',
  'last-30': 'Last 30 days',
  custom: 'Custom range',
};

function rangeForPreset(preset: Preset, today: string): { from: string; to: string } | null {
  switch (preset) {
    case 'this-month':
      return { from: startOfMonth(today), to: endOfMonth(today) };
    case 'last-month':
      return previousMonthRange(today);
    case 'last-7':
      return { from: addDays(today, -6), to: today };
    case 'last-30':
      return { from: addDays(today, -29), to: today };
    case 'custom':
      return null;
  }
}

/**
 * Whole seconds since `startedAt`, ticking live; `0` while nothing is running.
 *
 * The elapsed figure is derived from the start timestamp rather than
 * accumulated in state, so it stays correct across a backgrounded WebView that
 * throttled the interval to a crawl — and there is no state to reset when the
 * work finishes.
 */
function useElapsedSeconds(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (startedAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [startedAt]);

  if (startedAt === null) return 0;
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

export default function AdminExportScreen() {
  const { user } = useAuth();
  const timezone = user?.timezone ?? 'UTC';

  // "Today" is the organization's today, not the handset's: an admin in London
  // exporting a Riyadh tenant's month must get Riyadh's month boundaries.
  const today = useMemo(() => isoDateIn(timezone), [timezone]);

  const [preset, setPreset] = useState<Preset>('this-month');
  const [from, setFrom] = useState(() => startOfMonth(today));
  const [to, setTo] = useState(() => endOfMonth(today));
  const [userId, setUserId] = useState<string>(ALL_PEOPLE);
  const [format, setFormat] = useState<ExportFormat>(ExportFormat.XLSX);
  const [variant, setVariant] = useState<ExportVariant>(ExportVariant.DETAILED);
  const [outcome, setOutcome] = useState<SaveOutcome | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);

  // Guards a second tap arriving before React re-renders the button disabled —
  // a duplicate export is a second multi-second server job for nothing.
  const downloadLatch = useRef(false);

  const applyPreset = (next: Preset) => {
    setPreset(next);
    const range = rangeForPreset(next, today);
    if (range) {
      setFrom(range.from);
      setTo(range.to);
    }
  };

  // Editing a date by hand means the range is no longer whatever preset produced
  // it; saying so keeps the picker from lying about what will be exported.
  const editFrom = (value: string) => {
    setFrom(value);
    setPreset('custom');
  };
  const editTo = (value: string) => {
    setTo(value);
    setPreset('custom');
  };

  /**
   * A result describes the selection that produced it. The moment any part of
   * that selection changes, "Downloaded wasel-attendance-2026-09.xlsx" is
   * talking about a file that has nothing to do with what the form now says —
   * so it is cleared, during render, before either can be painted together.
   */
  const selection = `${from}|${to}|${userId}|${format}|${variant}`;
  const [resultFor, setResultFor] = useState(selection);
  if (resultFor !== selection) {
    setResultFor(selection);
    if (outcome !== null) setOutcome(null);
    if (failure !== null) setFailure(null);
  }

  const orderValid = from !== '' && to !== '' && from <= to;
  const days = orderValid ? inclusiveDayCount(from, to) : 0;
  const withinLimit = days > 0 && days <= EXPORT_MAX_RANGE_DAYS;
  const rangeValid = orderValid && withinLimit;

  const rangeError = !orderValid
    ? from === '' || to === ''
      ? 'Choose both a start and an end date.'
      : 'The start date must be on or before the end date.'
    : !withinLimit
      ? `A range may cover at most ${EXPORT_MAX_RANGE_DAYS} days; this one covers ${days}.`
      : null;

  /**
   * Everyone, for the person filter.
   *
   * Paged through in full rather than taking the first page: an organization
   * with 120 employees would otherwise silently hide 20 of them from a filter
   * whose whole purpose is picking one specific person.
   */
  const people = useQuery({
    queryKey: [...queryKeys.admin.all, 'users', 'all-for-export'] as const,
    queryFn: async ({ signal }) => {
      const collected: UserDto[] = [];
      let page = 1;
      // Bounded so a pathological tenant cannot spin here forever.
      for (let guard = 0; guard < 20; guard += 1) {
        const result = await adminApi.listUsers({ page, pageSize: PAGE_SIZE_MAX }, signal);
        collected.push(...result.data);
        if (!result.meta.hasNext) break;
        page += 1;
      }
      return collected;
    },
    staleTime: 60_000,
  });

  const reportQuery = useMemo(
    () => ({
      from,
      to,
      page: 1,
      // One row is enough: the summary is computed over the whole range
      // server-side, so pulling a full page of rows just to count them would be
      // wasted bytes on a phone connection.
      pageSize: 1,
      ...(userId === ALL_PEOPLE ? {} : { userId }),
    }),
    [from, to, userId],
  );

  const preview = useQuery({
    queryKey: queryKeys.admin.report(reportQuery),
    queryFn: ({ signal }) => adminApi.report(reportQuery, signal),
    enabled: rangeValid,
    placeholderData: keepPreviousData,
  });

  const download = useMutation({
    mutationFn: async (): Promise<SaveOutcome> => {
      const query: ExportQuery = {
        from,
        to,
        format,
        variant,
        ...(userId === ALL_PEOPLE ? {} : { userId }),
      };
      const response = await adminApi.exportAttendance(query);
      // Only ever used when the server sent no filename; it still names the
      // variant, because two files of one range that differ only in their columns
      // must not land in the same folder under one name.
      const kind = variant === ExportVariant.MINIFIED ? 'minified-' : '';
      const fallback = `wasel-attendance-${kind}${from}_${to}.${format}`;
      return saveFile(response.blob, response.filename, fallback);
    },
    onSuccess: (result) => {
      // The dock banner below states where the file went, and states it
      // permanently. A toast would say the same thing while covering it.
      setOutcome(result);
      setFailure(null);
    },
    onError: (error: unknown) => {
      setOutcome(null);
      if (error instanceof SaveFileError) {
        setFailure(`${error.message} The export itself was built successfully.`);
        return;
      }
      setFailure(
        isOffline(error)
          ? 'The export could not be downloaded — the server could not be reached. Nothing was saved.'
          : toDisplayMessage(error),
      );
    },
    onSettled: () => {
      downloadLatch.current = false;
      setStartedAt(null);
    },
  });

  const elapsed = useElapsedSeconds(startedAt);

  const start = () => {
    if (downloadLatch.current || download.isPending || !rangeValid) return;
    downloadLatch.current = true;
    setOutcome(null);
    setFailure(null);
    setResultFor(selection);
    setStartedAt(Date.now());
    download.mutate();
  };

  const summary = preview.data?.summary;
  const emptyRange = preview.isSuccess && summary?.totalRecords === 0;
  const selectedPerson = people.data?.find((person) => person.id === userId);
  const columns = EXPORT_VARIANT_COLUMNS[variant];
  const variantNote = VARIANT_NOTE[variant];

  return (
    <Screen
      title="Export"
      eyebrow="Admin"
      subtitle="Download the attendance sheet for a date range."
      action={<AccountButton />}
    >
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Date range</h2>

        <Select
          label="Range"
          value={preset}
          onChange={(event) => applyPreset(event.target.value as Preset)}
        >
          {(Object.keys(PRESET_LABEL) as Preset[]).map((key) => (
            <option key={key} value={key}>
              {PRESET_LABEL[key]}
            </option>
          ))}
        </Select>

        <div className={styles.pair}>
          <Input
            label="From"
            type="date"
            required
            value={from}
            max={to || undefined}
            onChange={(event) => editFrom(event.target.value)}
          />
          <Input
            label="To"
            type="date"
            required
            value={to}
            min={from || undefined}
            onChange={(event) => editTo(event.target.value)}
          />
        </div>

        {rangeError ? (
          <Banner tone="danger" title={rangeError} />
        ) : (
          <p className={styles.rangeNote}>
            {days} {days === 1 ? 'day' : 'days'}, inclusive. Dates are calendar days in{' '}
            {timezone.replace(/_/g, ' ')}.
          </p>
        )}
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Who and what</h2>

        <Select
          label="Person"
          value={userId}
          disabled={people.isPending}
          onChange={(event) => setUserId(event.target.value)}
          hint={
            people.isError
              ? 'The people list could not be loaded; the export will cover everyone.'
              : undefined
          }
        >
          <option value={ALL_PEOPLE}>Everyone</option>
          {(people.data ?? []).map((person) => (
            <option key={person.id} value={person.id}>
              {person.fullName}
              {person.employeeCode ? ` (${person.employeeCode})` : ''}
            </option>
          ))}
        </Select>

        <SegmentedControl<ExportVariant>
          label="Sheet"
          fullWidth
          value={variant}
          onChange={setVariant}
          options={[
            {
              value: ExportVariant.DETAILED,
              label: VARIANT_COPY[ExportVariant.DETAILED].label,
              meta: VARIANT_COPY[ExportVariant.DETAILED].meta,
            },
            {
              value: ExportVariant.MINIFIED,
              label: VARIANT_COPY[ExportVariant.MINIFIED].label,
              meta: VARIANT_COPY[ExportVariant.MINIFIED].meta,
            },
          ]}
        />

        <SegmentedControl<ExportFormat>
          label="File format"
          fullWidth
          value={format}
          onChange={setFormat}
          options={[
            { value: ExportFormat.XLSX, label: 'Excel', meta: '.xlsx' },
            { value: ExportFormat.CSV, label: 'CSV', meta: '.csv' },
          ]}
        />
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>What you will get</h2>

        {/* The columns do not depend on the range, so this is shown even while
            the dates are wrong: it is the half of the preview that answers
            "did I pick the right sheet", which is the mistake that costs a
            second download. */}
        <Card variant="outlined">
          <div className={styles.columns}>
            <div className={styles.columnsHead}>
              <p className={styles.columnsTitle}>{VARIANT_COPY[variant].label} sheet</p>
              <span className={styles.columnsCount}>
                {columns.length} {columns.length === 1 ? 'column' : 'columns'}
              </span>
            </div>
            <p className={styles.columnsPurpose}>{VARIANT_COPY[variant].purpose}</p>
            <ol className={styles.columnList}>
              {columns.map((column, index) => (
                <li key={column} className={styles.column}>
                  <span className={styles.columnIndex}>{index + 1}</span>
                  {column}
                </li>
              ))}
            </ol>
            <p className={styles.columnsNote}>
              Check-in and check-out are the wall clock in {timezone.replace(/_/g, ' ')}, and the
              file says so.
              {variantNote === null ? '' : ` ${variantNote}`}
            </p>
          </div>
        </Card>

        {!rangeValid ? (
          <Card variant="outlined">
            <p className="u-body-sm">Fix the date range above to see how many rows it will have.</p>
          </Card>
        ) : preview.isPending ? (
          <Card>
            <div className={styles.summary} aria-busy="true">
              <span className="u-visually-hidden">Counting matching records</span>
              <Skeleton shape="rounded" height="3rem" />
              <Skeleton shape="rounded" height="1.5rem" width="70%" />
            </div>
          </Card>
        ) : preview.isError ? (
          <LoadFailure
            compact
            error={preview.error}
            subject="the preview"
            onRetry={() => void preview.refetch()}
          />
        ) : summary ? (
          <Card>
            <div className={styles.summary}>
              <CardHeader
                title={selectedPerson ? selectedPerson.fullName : 'Everyone'}
                subtitle={formatDateRange(from, to)}
              />
              <div className={styles.summaryGrid}>
                <div className={styles.summaryItem}>
                  <span className={styles.summaryValue}>{summary.totalRecords}</span>
                  <span className={styles.summaryLabel}>
                    {summary.totalRecords === 1 ? 'row' : 'rows'}
                  </span>
                </div>
                <div className={styles.summaryItem}>
                  <span className={styles.summaryValue}>{summary.distinctUsers}</span>
                  <span className={styles.summaryLabel}>
                    {summary.distinctUsers === 1 ? 'person' : 'people'}
                  </span>
                </div>
              </div>
              <div className={styles.breakdown}>
                {/* A zero count is stated, not highlighted: an amber "0 late"
                    colours good news as a problem and teaches the eye to
                    discount the very colour that is meant to carry weight. */}
                <Badge tone={summary.presentCount > 0 ? 'success' : 'neutral'}>
                  {summary.presentCount} present
                </Badge>
                <Badge tone={summary.lateCount > 0 ? 'warning' : 'neutral'}>
                  {summary.lateCount} late
                </Badge>
                <Badge tone="neutral">{summary.incompleteCount} open</Badge>
                <Badge tone="accent">{formatDuration(summary.totalWorkedMinutes)} worked</Badge>
              </div>
            </div>
          </Card>
        ) : null}

        {emptyRange ? (
          <Banner
            tone="warning"
            title="Nothing was recorded in this range"
            description="You can still download it — the file will contain the column headers and no rows. Widen the range or clear the person filter to get data."
          />
        ) : null}
      </section>

      <div className={styles.dock} data-sticky-dock>
        {download.isPending ? (
          <div className={styles.progress} role="status">
            <Spinner size="md" />
            <div className={styles.progressText}>
              <span className={styles.progressTitle}>
                {elapsed < 5 ? 'Building your sheet…' : 'Still building — large ranges take longer'}
              </span>
              <span className={styles.progressDetail}>
                {elapsed}s elapsed · {days} {days === 1 ? 'day' : 'days'} ·{' '}
                {VARIANT_COPY[variant].label} · {format.toUpperCase()}
              </span>
            </div>
          </div>
        ) : null}

        {failure ? (
          <Banner
            tone="danger"
            title="The export did not complete"
            description={failure}
            action={
              <Button variant="secondary" size="sm" onClick={start}>
                Try again
              </Button>
            }
          />
        ) : null}

        {outcome ? <Banner tone="success" {...describeOutcome(outcome)} /> : null}

        <Button
          size="lg"
          fullWidth
          iconStart={<DownloadIcon size="1.15rem" />}
          loading={download.isPending}
          disabled={!rangeValid}
          onClick={start}
        >
          {download.isPending
            ? 'Preparing…'
            : `Download ${VARIANT_COPY[variant].label.toLowerCase()} ${
                format === ExportFormat.CSV ? 'CSV' : 'Excel'
              } file`}
        </Button>
      </div>
    </Screen>
  );
}

/**
 * What actually happened to the bytes, said plainly.
 *
 * A phone has no downloads bar, so "Downloaded!" is a lie there — the four cases
 * below are genuinely different, and the one the user needs most is the path the
 * file was written to when the share sheet was dismissed.
 */
function describeOutcome(outcome: SaveOutcome): { title: string; description: string } {
  switch (outcome.kind) {
    case 'browser-download':
      return {
        title: 'Downloaded',
        description: `${outcome.filename} is in your browser's downloads.`,
      };
    case 'shared':
      return {
        title: 'Export sent',
        description: `${outcome.filename} was handed to the app you chose.`,
      };
    case 'share-dismissed':
      return {
        title: 'Saved to this device',
        description: `You closed the share sheet, but ${outcome.filename} is saved at ${outcome.location}.`,
      };
    case 'saved':
      return {
        title: 'Saved to this device',
        description: `${outcome.filename} is at ${outcome.location}.`,
      };
  }
}
