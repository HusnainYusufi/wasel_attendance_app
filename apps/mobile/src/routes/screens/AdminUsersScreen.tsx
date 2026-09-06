import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { PAGE_SIZE_DEFAULT, Role, UserStatus, type UserDto } from '@wasel/contracts';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { adminApi, queryKeys } from '../../api';
import { LoadFailure } from '../../components/LoadFailure';
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  List,
  ListItem,
  PlusIcon,
  Screen,
  SearchIcon,
  Select,
  Skeleton,
  UsersIcon,
} from '../../design';
import { AccountButton } from '../../features/account/AccountButton';
import { UserSheet, type UserSheetTarget } from '../../features/admin/UserSheet';
import { paths } from '../paths';
import styles from './AdminUsersScreen.module.css';

const PAGE_SIZE = PAGE_SIZE_DEFAULT;
const ROLE_ANY = 'ANY';
const STATUS_ANY = 'ANY';

type RoleFilter = Role | typeof ROLE_ANY;
type StatusFilter = UserStatus | typeof STATUS_ANY;

export default function AdminUsersScreen() {
  const navigate = useNavigate();

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [role, setRole] = useState<RoleFilter>(ROLE_ANY);
  const [status, setStatus] = useState<StatusFilter>(STATUS_ANY);
  const [page, setPage] = useState(1);
  const [target, setTarget] = useState<UserSheetTarget | null>(null);

  // Typing must not fire a request per keystroke; 300ms is long enough to batch
  // a burst and short enough that the list still feels live.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Any filter change invalidates the current page number — page 4 of the old
  // result set is very unlikely to exist in the new one. Adjusted during render
  // rather than in an effect, so no request is ever issued for the stale page.
  const filterKey = `${debouncedSearch}|${role}|${status}`;
  const [appliedFilterKey, setAppliedFilterKey] = useState(filterKey);
  if (appliedFilterKey !== filterKey) {
    setAppliedFilterKey(filterKey);
    setPage(1);
  }

  const query = useMemo(
    () => ({
      page,
      pageSize: PAGE_SIZE,
      ...(debouncedSearch ? { search: debouncedSearch } : {}),
      ...(role === ROLE_ANY ? {} : { role }),
      ...(status === STATUS_ANY ? {} : { status }),
    }),
    [page, debouncedSearch, role, status],
  );

  const users = useQuery({
    queryKey: queryKeys.admin.users(query),
    queryFn: ({ signal }) => adminApi.listUsers(query, signal),
    // The previous page stays on screen while the next one loads, so refining a
    // search does not flash an empty list between every keystroke.
    placeholderData: keepPreviousData,
  });

  const data = users.data;
  const total = data?.meta.total ?? 0;
  const filtered = debouncedSearch !== '' || role !== ROLE_ANY || status !== STATUS_ANY;

  const frame = (children: ReactNode) => (
    <Screen
      title="People"
      eyebrow="Admin"
      subtitle="Add, suspend and reset the people in this organization."
      onBack={() => void navigate(paths.admin)}
      backLabel="Back to admin"
      action={<AccountButton />}
    >
      <div className={styles.filters}>
        <Input
          label="Search"
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          iconStart={<SearchIcon size="1.1rem" />}
          placeholder="Name, email or code"
          inputMode="search"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="search"
        />

        <div className={styles.filterPair}>
          <Select
            label="Role"
            value={role}
            onChange={(event) => setRole(event.target.value as RoleFilter)}
          >
            {/* "Administrators" overruns the chevron in a half-width select at
                360px; the short form is unambiguous next to a "Role" label. */}
            <option value={ROLE_ANY}>Everyone</option>
            <option value={Role.ADMIN}>Admins</option>
            <option value={Role.MEMBER}>Members</option>
          </Select>
          <Select
            label="Status"
            value={status}
            onChange={(event) => setStatus(event.target.value as StatusFilter)}
          >
            <option value={STATUS_ANY}>Any status</option>
            <option value={UserStatus.ACTIVE}>Active</option>
            <option value={UserStatus.SUSPENDED}>Suspended</option>
          </Select>
        </div>
      </div>

      <div className={styles.addRow}>
        <Button
          fullWidth
          iconStart={<PlusIcon size="1.1rem" />}
          onClick={() => setTarget({ mode: 'create' })}
        >
          Add a person
        </Button>
      </div>

      {children}

      <UserSheet target={target} onClose={() => setTarget(null)} />
    </Screen>
  );

  if (users.isPending) {
    return frame(
      <div className={styles.skeletonRows} aria-busy="true">
        <span className="u-visually-hidden">Loading people</span>
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} shape="rounded" height="4rem" />
        ))}
      </div>,
    );
  }

  if (users.isError) {
    return frame(
      <LoadFailure
        error={users.error}
        subject="the people list"
        onRetry={() => void users.refetch()}
      />,
    );
  }

  if (total === 0) {
    return frame(
      <EmptyState
        icon={<UsersIcon size="1.65rem" />}
        title={filtered ? 'Nobody matches those filters' : 'Nobody here yet'}
        description={
          filtered
            ? 'Try a different search term, or widen the role and status filters.'
            : 'Add the first person and they will be able to check in straight away.'
        }
        action={
          filtered ? (
            <Button
              variant="secondary"
              onClick={() => {
                setSearch('');
                setRole(ROLE_ANY);
                setStatus(STATUS_ANY);
              }}
            >
              Clear filters
            </Button>
          ) : (
            <Button onClick={() => setTarget({ mode: 'create' })}>Add a person</Button>
          )
        }
      />,
    );
  }

  const meta = data?.meta;

  return frame(
    <>
      <p className={styles.resultRow} aria-live="polite">
        <span>
          {total} {total === 1 ? 'person' : 'people'}
          {filtered ? ' matching' : ''}
        </span>
        {users.isFetching ? <span>Updating…</span> : null}
      </p>

      <Card padding="none">
        <List inset>
          {(data?.data ?? []).map((person) => (
            <li key={person.id}>
              <ListItem
                interactive
                chevron
                onClick={() => setTarget({ mode: 'manage', user: person })}
                leading={<Avatar name={person.fullName} size="md" />}
                title={person.fullName}
                description={describePerson(person)}
                trailing={<PersonBadges person={person} />}
              />
            </li>
          ))}
        </List>
      </Card>

      {meta && meta.totalPages > 1 ? (
        <div className={styles.pager}>
          <Button
            variant="secondary"
            size="sm"
            disabled={!meta.hasPrevious || users.isFetching}
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
            disabled={!meta.hasNext || users.isFetching}
            onClick={() => setPage((current) => current + 1)}
          >
            Next
          </Button>
        </div>
      ) : null}
    </>,
  );
}

function describePerson(person: UserDto): string {
  return person.employeeCode ? `${person.employeeCode} · ${person.email}` : person.email;
}

/**
 * Only the exceptions are badged.
 *
 * An active member is the default state, so badging it would put a label on
 * every row and leave the eye nothing to catch. A suspended person and an
 * administrator are the two rows an admin is scanning for.
 */
function PersonBadges({ person }: { person: UserDto }) {
  const isAdmin = person.role === Role.ADMIN;
  const suspended = person.status === UserStatus.SUSPENDED;
  if (!isAdmin && !suspended) return null;

  return (
    <span className={styles.trailing}>
      {suspended ? (
        <Badge tone="danger" size="sm" dot>
          Suspended
        </Badge>
      ) : null}
      {isAdmin && !suspended ? (
        <Badge tone="accent" size="sm">
          Admin
        </Badge>
      ) : null}
    </span>
  );
}
