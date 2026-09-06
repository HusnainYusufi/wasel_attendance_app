import { useQuery } from '@tanstack/react-query';
import { formatDistance, type SiteDto } from '@wasel/contracts';
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { adminApi, queryKeys } from '../../api';
import { LoadFailure } from '../../components/LoadFailure';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  List,
  ListItem,
  MapPinIcon,
  PlusIcon,
  Screen,
  Skeleton,
} from '../../design';
import { AccountButton } from '../../features/account/AccountButton';
import { SiteSheet, type SiteSheetTarget } from '../../features/admin/SiteSheet';
import { paths } from '../paths';
import styles from './AdminSitesScreen.module.css';

export default function AdminSitesScreen() {
  const navigate = useNavigate();
  const [target, setTarget] = useState<SiteSheetTarget | null>(null);

  const sites = useQuery({
    queryKey: queryKeys.admin.sites(),
    queryFn: ({ signal }) => adminApi.listSites(signal),
  });

  const rows = sites.data?.data ?? [];
  const activeCount = rows.filter((site) => site.isActive).length;

  const frame = (children: ReactNode) => (
    <Screen
      title="Sites"
      eyebrow="Admin"
      subtitle="The geofences every check-in is measured against."
      onBack={() => void navigate(paths.admin)}
      backLabel="Back to admin"
      action={<AccountButton />}
    >
      <Button
        fullWidth
        iconStart={<PlusIcon size="1.1rem" />}
        onClick={() => setTarget({ mode: 'create' })}
      >
        Add a site
      </Button>

      {children}

      <SiteSheet target={target} onClose={() => setTarget(null)} />
    </Screen>
  );

  if (sites.isPending) {
    return frame(
      <div className={styles.skeletonRows} aria-busy="true">
        <span className="u-visually-hidden">Loading sites</span>
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} shape="rounded" height="4.5rem" />
        ))}
      </div>,
    );
  }

  if (sites.isError) {
    return frame(
      <LoadFailure
        error={sites.error}
        subject="the site list"
        onRetry={() => void sites.refetch()}
      />,
    );
  }

  if (rows.length === 0) {
    return frame(
      <EmptyState
        icon={<MapPinIcon size="1.65rem" />}
        title="No sites yet"
        description="Nobody can check in until at least one site exists. Add one from where you are standing, or type the coordinates."
        action={<Button onClick={() => setTarget({ mode: 'create' })}>Add a site</Button>}
      />,
    );
  }

  return frame(
    <>
      <p className={styles.summary}>
        {rows.length} {rows.length === 1 ? 'site' : 'sites'} · {activeCount} accepting punches
      </p>

      {activeCount === 0 ? (
        <Card variant="outlined">
          <p className="u-body-sm">
            Every site is switched off, so no check-in can succeed anywhere. Switch at least one
            back on.
          </p>
        </Card>
      ) : null}

      <Card padding="none">
        <List>
          {rows.map((site) => (
            <li key={site.id}>
              <ListItem
                interactive
                chevron
                onClick={() => setTarget({ mode: 'edit', site })}
                title={
                  <span className={styles.rowTitle}>
                    <span className={styles.name}>{site.name}</span>
                    {site.isActive ? null : (
                      <Badge tone="neutral" size="sm">
                        Off
                      </Badge>
                    )}
                  </span>
                }
                description={describeSite(site)}
                trailing={
                  <span className={styles.radius}>{formatDistance(site.radiusMeters)}</span>
                }
              />
            </li>
          ))}
        </List>
      </Card>
    </>,
  );
}

/**
 * The address if there is one, else the coordinates — a site with neither would
 * otherwise be an unidentifiable row named only by its label.
 */
function describeSite(site: SiteDto): ReactNode {
  if (site.address) return site.address;
  return (
    <span className={styles.coords}>
      {site.latitude.toFixed(5)}, {site.longitude.toFixed(5)}
    </span>
  );
}
