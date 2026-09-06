import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { adminApi, queryKeys } from '../../api';
import { useAuth } from '../../auth';
import { LoadFailure } from '../../components/LoadFailure';
import { StatGrid, StatTile } from '../../components/StatTile';
import {
  Card,
  DownloadIcon,
  List,
  ListItem,
  MapPinIcon,
  Screen,
  ShieldIcon,
  UsersIcon,
} from '../../design';
import { AccountButton } from '../../features/account/AccountButton';
import { OrganizationSheet } from '../../features/admin/OrganizationSheet';
import { formatWorkDate } from '../../lib/datetime';
import type { StatTone } from '../../components/StatTile';
import { paths } from '../paths';
import styles from './AdminScreen.module.css';

const NAV_ROWS = [
  {
    to: paths.adminUsers,
    icon: <UsersIcon size="1.2rem" />,
    title: 'People',
    description: 'Add, suspend, reset passwords',
  },
  {
    to: paths.adminSites,
    icon: <MapPinIcon size="1.2rem" />,
    title: 'Sites',
    description: 'Geofences for check-in',
  },
  {
    to: paths.adminExport,
    icon: <DownloadIcon size="1.2rem" />,
    title: 'Export',
    description: 'Attendance sheet, CSV or XLSX',
  },
] as const;

/** A figure's tone, but only once the figure is worth noticing. */
function tone(value: number | undefined, when: StatTone): StatTone {
  return value !== undefined && value > 0 ? when : 'neutral';
}

export default function AdminScreen() {
  const { user } = useAuth();
  const [settingsOpen, setSettingsOpen] = useState(false);

  const overview = useQuery({
    queryKey: queryKeys.admin.overview(),
    queryFn: ({ signal }) => adminApi.overview(signal),
  });

  const data = overview.data;
  const loading = overview.isPending;

  return (
    <Screen
      title="Admin"
      eyebrow={user?.organizationName}
      subtitle={
        data ? (
          <>
            Today, <span className={styles.reportDate}>{formatWorkDate(data.workDate)}</span> in{' '}
            {data.timezone.replace(/_/g, ' ')}.
          </>
        ) : (
          'Today at a glance.'
        )
      }
      action={<AccountButton />}
    >
      {overview.isError ? (
        <LoadFailure
          error={overview.error}
          subject="today's figures"
          onRetry={() => void overview.refetch()}
        />
      ) : (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Today</h2>
          <StatGrid>
            <StatTile
              label="Checked in"
              value={data?.checkedInCount ?? 0}
              loading={loading}
              // Tone only when the figure is non-zero. A red "0 rejected" or an
              // amber "0 late" colours good news as a problem and trains the
              // eye to ignore the colour that is supposed to mean something.
              tone={tone(data?.checkedInCount, 'success')}
              hint="Opened a day"
            />
            <StatTile
              label="Checked out"
              value={data?.checkedOutCount ?? 0}
              loading={loading}
              hint="Closed a day"
            />
            <StatTile
              label="Late"
              value={data?.lateCount ?? 0}
              loading={loading}
              tone={tone(data?.lateCount, 'warning')}
            />
            <StatTile
              label="Absent"
              value={data?.absentCount ?? 0}
              loading={loading}
              hint="No punch today"
            />
            <StatTile label="Active people" value={data?.totalActiveUsers ?? 0} loading={loading} />
            <StatTile
              label="Rejected attempts"
              value={data?.rejectedAttemptsToday ?? 0}
              loading={loading}
              tone={tone(data?.rejectedAttemptsToday, 'danger')}
              hint="Out of range, poor GPS, or shift rules"
            />
          </StatGrid>
        </section>
      )}

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Manage</h2>
        <Card padding="none">
          <List inset>
            {NAV_ROWS.map((row) => (
              <li key={row.to}>
                <ListItem
                  as={Link}
                  {...{ to: row.to }}
                  chevron
                  interactive
                  leading={
                    <span className={styles.navIcon} aria-hidden="true">
                      {row.icon}
                    </span>
                  }
                  title={row.title}
                  description={row.description}
                />
              </li>
            ))}
            <li>
              <ListItem
                interactive
                chevron
                onClick={() => setSettingsOpen(true)}
                leading={
                  <span className={styles.navIcon} aria-hidden="true">
                    <ShieldIcon size="1.2rem" />
                  </span>
                }
                title="Organization settings"
                description="Timezone, workday, day boundary, GPS"
              />
            </li>
          </List>
        </Card>
      </section>

      <OrganizationSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </Screen>
  );
}
