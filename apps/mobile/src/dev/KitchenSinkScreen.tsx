import { useEffect, useState, type ReactNode } from 'react';
import {
  AlertIcon,
  Avatar,
  Badge,
  Button,
  Card,
  CardHeader,
  CheckIcon,
  DownloadIcon,
  EmptyState,
  IconButton,
  Input,
  List,
  ListItem,
  Logo,
  MailIcon,
  MapPinIcon,
  PlusIcon,
  SearchIcon,
  SegmentedControl,
  Select,
  Sheet,
  Skeleton,
  Spinner,
  useTheme,
  useToast,
  type BadgeTone,
  type BadgeVariant,
  type ButtonSize,
  type ButtonVariant,
  type ThemePreference,
} from '../design';
import styles from './KitchenSink.module.css';

/**
 * Dev-only visual reference for every primitive in every state.
 *
 * Routed at `/__kitchen-sink` behind `import.meta.env.DEV`, so it is tree-shaken
 * out of a production bundle. Reviewers use it to eyeball both themes at 360px
 * and 430px without needing a running API.
 */

function Section({ name, note, children }: { name: string; note?: string; children: ReactNode }) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionTitle}>
        <h2 className={styles.sectionName}>{name}</h2>
        {note ? <span className={styles.sectionNote}>{note}</span> : null}
      </div>
      {children}
    </section>
  );
}

const SURFACE_TOKENS = [
  '--color-bg',
  '--color-bg-elevated',
  '--color-bg-raised',
  '--color-bg-sunken',
  '--color-bg-hover',
  '--color-bg-active',
  '--color-accent',
  '--color-accent-soft',
  '--color-success',
  '--color-success-soft',
  '--color-warning',
  '--color-warning-soft',
  '--color-danger',
  '--color-danger-soft',
  '--color-border',
  '--color-border-strong',
];

const CONTRAST_PAIRS: Array<{ label: string; fg: string; bg: string }> = [
  { label: 'text on bg', fg: '--color-text', bg: '--color-bg' },
  { label: 'text on elevated', fg: '--color-text', bg: '--color-bg-elevated' },
  { label: 'muted on elevated', fg: '--color-text-muted', bg: '--color-bg-elevated' },
  { label: 'subtle on elevated', fg: '--color-text-subtle', bg: '--color-bg-elevated' },
  { label: 'accent text on bg', fg: '--color-accent-text', bg: '--color-bg' },
  { label: 'accent fg on accent', fg: '--color-accent-fg', bg: '--color-accent' },
  { label: 'danger fg on danger', fg: '--color-danger-fg', bg: '--color-danger' },
  { label: 'success fg on success', fg: '--color-success-fg', bg: '--color-success' },
  { label: 'warning fg on warning', fg: '--color-warning-fg', bg: '--color-warning' },
  { label: 'accent soft fg on soft', fg: '--color-accent-soft-fg', bg: '--color-accent-soft' },
  { label: 'danger soft fg on soft', fg: '--color-danger-soft-fg', bg: '--color-danger-soft' },
  { label: 'warning soft fg on soft', fg: '--color-warning-soft-fg', bg: '--color-warning-soft' },
  { label: 'success soft fg on soft', fg: '--color-success-soft-fg', bg: '--color-success-soft' },
];

const BUTTON_VARIANTS: ButtonVariant[] = ['primary', 'secondary', 'ghost', 'danger', 'success'];
const BUTTON_SIZES: ButtonSize[] = ['sm', 'md', 'lg', 'xl'];
const BADGE_TONES: BadgeTone[] = ['neutral', 'accent', 'success', 'warning', 'danger'];
const BADGE_VARIANTS: BadgeVariant[] = ['soft', 'solid', 'outline'];

/** WCAG 2.x relative luminance, computed from the resolved token colours. */
function contrastRatio(a: string, b: string): number | null {
  const parse = (value: string): [number, number, number] | null => {
    const match = /rgba?\(([^)]+)\)/.exec(value);
    if (!match?.[1]) return null;
    const parts = match[1]
      .split(/[,\s/]+/)
      .filter(Boolean)
      .map(Number);
    const [r, g, bl] = parts;
    if (r === undefined || g === undefined || bl === undefined) return null;
    return [r, g, bl];
  };
  const lum = (rgb: [number, number, number]): number => {
    const [r, g, bl] = rgb.map((c) => {
      const s = c / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const first = parse(a);
  const second = parse(b);
  if (!first || !second) return null;
  const l1 = lum(first);
  const l2 = lum(second);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

function useContrastReport(): Array<{
  label: string;
  ratio: number | null;
  fg: string;
  bg: string;
}> {
  const { resolved } = useTheme();
  const [report, setReport] = useState<
    Array<{ label: string; ratio: number | null; fg: string; bg: string }>
  >([]);

  useEffect(() => {
    // Read after paint so the freshly-applied `color-scheme` has resolved every
    // `light-dark()` token.
    const raf = requestAnimationFrame(() => {
      const probe = document.createElement('span');
      document.body.appendChild(probe);
      const next = CONTRAST_PAIRS.map(({ label, fg, bg }) => {
        probe.style.color = `var(${fg})`;
        const fgColor = getComputedStyle(probe).color;
        probe.style.color = `var(${bg})`;
        const bgColor = getComputedStyle(probe).color;
        return { label, fg, bg, ratio: contrastRatio(fgColor, bgColor) };
      });
      probe.remove();
      setReport(next);
    });
    return () => cancelAnimationFrame(raf);
  }, [resolved]);

  return report;
}

export default function KitchenSinkScreen() {
  const { preference, resolved, setPreference } = useTheme();
  const toast = useToast();
  const [segment, setSegment] = useState<'all' | 'present' | 'late'>('all');
  const [bottomSheet, setBottomSheet] = useState(false);
  const [centerSheet, setCenterSheet] = useState(false);
  const [text, setText] = useState('');
  const contrast = useContrastReport();

  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <header className={styles.header}>
          <Logo size="md" withText />
          <div>
            <h1 className={styles.title}>Kitchen sink</h1>
            <p className={styles.lede}>
              Every primitive, every state — resolved theme: <strong>{resolved}</strong>.
            </p>
          </div>
          <SegmentedControl<ThemePreference>
            label="Theme"
            fullWidth
            value={preference}
            onChange={setPreference}
            options={[
              { value: 'system', label: 'System' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
        </header>

        <Section name="Surfaces & fills" note="semantic tokens">
          <div className={styles.swatches}>
            {SURFACE_TOKENS.map((token) => (
              <div key={token} className={styles.swatch}>
                <div className={styles.chip} style={{ backgroundColor: `var(${token})` }} />
                <span className={styles.chipName}>{token.replace('--color-', '')}</span>
              </div>
            ))}
          </div>
        </Section>

        <Section name="Contrast" note="measured in-browser">
          <div className={styles.pairs}>
            {contrast.map(({ label, ratio, fg, bg }) => (
              <div
                key={label}
                className={styles.pair}
                style={{ backgroundColor: `var(${bg})`, color: `var(${fg})` }}
              >
                <span>{label}</span>
                <span className={styles.pairRatio}>
                  {ratio === null ? '—' : `${ratio.toFixed(2)}:1`}
                </span>
              </div>
            ))}
          </div>
        </Section>

        <Section name="Type scale">
          <div className={styles.specimens}>
            <div className={styles.specimen}>
              <span className={styles.clock}>08:59:04</span>
              <span className={styles.specimenMeta}>clock · 52px · tabular-nums</span>
            </div>
            <div className={styles.specimen}>
              <p className="u-display">Checked in</p>
              <span className={styles.specimenMeta}>display · 40/1.15 · 700</span>
            </div>
            <div className={styles.specimen}>
              <p className="u-title-1">Attendance</p>
              <span className={styles.specimenMeta}>title-1 · 30/1.15 · 700</span>
            </div>
            <div className={styles.specimen}>
              <p className="u-title-2">This month</p>
              <span className={styles.specimenMeta}>title-2 · 24/1.3 · 600</span>
            </div>
            <div className={styles.specimen}>
              <p className="u-title-3">Riyadh HQ</p>
              <span className={styles.specimenMeta}>title-3 · 17/1.3 · 600</span>
            </div>
            <div className={styles.specimen}>
              <p className="u-body">
                You are 42 m from Riyadh HQ, inside the 150 m geofence. Tap to check in.
              </p>
              <span className={styles.specimenMeta}>body · 15/1.5 · 400</span>
            </div>
            <div className={styles.specimen}>
              <p className="u-body-sm">Recorded at 08:59 · accuracy ±12 m</p>
              <span className={styles.specimenMeta}>body-sm · 14/1.5 · muted</span>
            </div>
            <div className={styles.specimen}>
              <p className="u-caption">Server time, Asia/Riyadh</p>
              <span className={styles.specimenMeta}>caption · 13/1.3 · subtle</span>
            </div>
            <div className={styles.specimen}>
              <p className="u-overline">Recent activity</p>
              <span className={styles.specimenMeta}>overline · 11 · 600 · +0.07em</span>
            </div>
          </div>
        </Section>

        <Section name="Buttons" note="variant × size">
          <div className={styles.stack}>
            {BUTTON_VARIANTS.map((variant) => (
              <div key={variant}>
                <p className={styles.label}>{variant}</p>
                <div className={styles.row} style={{ marginBlockStart: 'var(--space-2)' }}>
                  {BUTTON_SIZES.map((size) => (
                    <Button key={size} variant={variant} size={size}>
                      {size === 'xl' ? 'Check in' : 'Button'}
                    </Button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Section>

        <Section name="Button states" note="default · disabled · loading">
          <div className={styles.stack}>
            {BUTTON_VARIANTS.map((variant) => (
              <div key={variant} className={styles.row}>
                <Button variant={variant}>Default</Button>
                <Button variant={variant} disabled>
                  Disabled
                </Button>
                <Button variant={variant} loading>
                  Loading
                </Button>
              </div>
            ))}
            <Button fullWidth size="xl" variant="success" iconStart={<CheckIcon size="1.2em" />}>
              Check in
            </Button>
            <Button fullWidth size="xl" variant="danger" loading>
              Checking out…
            </Button>
            <Button fullWidth variant="secondary" iconStart={<DownloadIcon size="1.15em" />}>
              Export attendance
            </Button>
          </div>
        </Section>

        <Section name="Icon buttons">
          <div className={styles.row}>
            <IconButton label="Add" icon={<PlusIcon size="1.2em" />} size="sm" />
            <IconButton label="Add" icon={<PlusIcon size="1.2em" />} size="md" />
            <IconButton label="Add" icon={<PlusIcon size="1.2em" />} size="lg" />
            <IconButton label="Search" icon={<SearchIcon size="1.2em" />} variant="outlined" />
            <IconButton label="Disabled" icon={<PlusIcon size="1.2em" />} disabled />
          </div>
        </Section>

        <Section name="Inputs">
          <div className={styles.stack}>
            <Input
              label="Work email"
              type="email"
              inputMode="email"
              autoComplete="username"
              placeholder="you@company.com"
              iconStart={<MailIcon size="1.15em" />}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
            <Input
              label="Password"
              type="password"
              autoComplete="current-password"
              revealToggle
              hint="At least 10 characters, with a letter and a number."
              defaultValue="hunter2hunter2"
            />
            <Input
              label="Employee code"
              hint="Letters, numbers, dot, dash, underscore."
              error="That employee code is already taken."
              defaultValue="EMP-001"
            />
            <Input label="Disabled" disabled defaultValue="Cannot edit" />
            <Input label="Geofence radius" size="lg" inputMode="numeric" defaultValue="150" />
            <Select label="Role" defaultValue="MEMBER">
              <option value="MEMBER">Member</option>
              <option value="ADMIN">Admin</option>
            </Select>
            <Select label="Status" error="Pick a status" defaultValue="">
              <option value="">Choose…</option>
              <option value="ACTIVE">Active</option>
              <option value="SUSPENDED">Suspended</option>
            </Select>
          </div>
        </Section>

        <Section name="Cards">
          <div className={styles.stack}>
            <Card>
              <CardHeader
                title="Riyadh HQ"
                subtitle="150 m radius · active"
                action={<Badge tone="success">Inside</Badge>}
              />
              <p className="u-body-sm">You are 42 m from the centre of this site.</p>
            </Card>
            <Card variant="outlined">
              <CardHeader title="Outlined" subtitle="A quieter container" />
              <p className="u-body-sm">Used for secondary groupings.</p>
            </Card>
            <Card variant="accent">
              <CardHeader title="Accent" subtitle="For the one thing that matters" />
              <p className="u-body-sm">Reserved for a single call-out per screen.</p>
            </Card>
            <Card interactive onClick={() => toast.show({ title: 'Card tapped' })}>
              <CardHeader title="Interactive card" subtitle="Renders as a real button" />
            </Card>
          </div>
        </Section>

        <Section name="Badges" note="tone × variant">
          <div className={styles.stack}>
            {BADGE_VARIANTS.map((variant) => (
              <div key={variant} className={styles.row}>
                {BADGE_TONES.map((tone) => (
                  <Badge key={tone} tone={tone} variant={variant} dot>
                    {tone}
                  </Badge>
                ))}
              </div>
            ))}
            <div className={styles.row}>
              {BADGE_TONES.map((tone) => (
                <Badge key={tone} tone={tone} size="sm">
                  {tone}
                </Badge>
              ))}
            </div>
          </div>
        </Section>

        <Section name="Segmented control">
          <div className={styles.stack}>
            <SegmentedControl
              label="Filter attendance"
              fullWidth
              value={segment}
              onChange={setSegment}
              options={[
                { value: 'all', label: 'All', meta: 42 },
                { value: 'present', label: 'Present', meta: 38 },
                { value: 'late', label: 'Late', meta: 4 },
              ]}
            />
            <SegmentedControl
              label="Export format"
              value="xlsx"
              onChange={() => undefined}
              options={[
                { value: 'csv', label: 'CSV' },
                { value: 'xlsx', label: 'XLSX' },
                { value: 'pdf', label: 'PDF', disabled: true },
              ]}
            />
          </div>
        </Section>

        <Section name="Avatars">
          <div className={styles.row}>
            <Avatar name="Aisha Rahman" size="xs" />
            <Avatar name="Bilal Khan" size="sm" />
            <Avatar name="Carla Mendes" size="md" />
            <Avatar name="Dmitri Volkov" size="lg" />
            <Avatar name="Eun-ji Park" size="xl" />
          </div>
        </Section>

        <Section name="List">
          <Card padding="none" className={styles.listCard}>
            <List inset>
              <li>
                <ListItem
                  interactive
                  chevron
                  leading={<Avatar name="Aisha Rahman" size="md" />}
                  title="Aisha Rahman"
                  description="aisha@wasel.app · EMP-001"
                  trailing={<Badge tone="success">Active</Badge>}
                />
              </li>
              <li>
                <ListItem
                  interactive
                  chevron
                  leading={<Avatar name="Bilal Khan" size="md" />}
                  title="Bilal Khan"
                  description="bilal@wasel.app"
                  trailing={<Badge tone="danger">Suspended</Badge>}
                />
              </li>
              <li>
                <ListItem
                  leading={<MapPinIcon size="1.3em" />}
                  title="A very long site name that has to truncate gracefully"
                  description="1 King Fahd Road, Riyadh"
                  trailing="150 m"
                />
              </li>
            </List>
          </Card>
        </Section>

        <Section name="Feedback" note="spinner · skeleton · empty">
          <div className={styles.stack}>
            <div className={styles.row}>
              <Spinner size="sm" />
              <Spinner size="md" />
              <Spinner size="lg" />
              <Spinner size="xl" />
            </div>
            <Card>
              <Skeleton shape="rounded" width="45%" height="1.25rem" />
              <div style={{ height: 'var(--space-3)' }} />
              <Skeleton />
              <Skeleton />
              <Skeleton width="70%" />
            </Card>
            <Card variant="outlined" padding="none">
              <EmptyState
                title="No attendance yet"
                description="Records appear here after your first check-in."
                action={<Button variant="secondary">Learn more</Button>}
              />
            </Card>
            <Card variant="outlined" padding="none">
              <EmptyState
                tone="danger"
                icon={<AlertIcon size="1.65rem" />}
                title="Could not load history"
                description="Check your connection and try again."
                action={<Button variant="secondary">Retry</Button>}
                compact
              />
            </Card>
          </div>
        </Section>

        <Section name="Overlays">
          <div className={styles.grid2}>
            <Button variant="secondary" onClick={() => setBottomSheet(true)}>
              Bottom sheet
            </Button>
            <Button variant="secondary" onClick={() => setCenterSheet(true)}>
              Confirm dialog
            </Button>
          </div>
        </Section>

        <Section name="Toasts">
          <div className={styles.grid2}>
            <Button
              variant="secondary"
              onClick={() =>
                toast.show({
                  tone: 'success',
                  title: 'Checked in',
                  description: 'Riyadh HQ · 42 m',
                })
              }
            >
              Success
            </Button>
            <Button
              variant="secondary"
              onClick={() =>
                toast.show({
                  tone: 'warning',
                  title: 'Weak GPS signal',
                  description: 'Accuracy ±180 m. Move outdoors and try again.',
                })
              }
            >
              Warning
            </Button>
            <Button
              variant="secondary"
              onClick={() =>
                toast.show({
                  tone: 'danger',
                  title: 'Out of range',
                  description: 'You are 1.4 km from Riyadh HQ.',
                  action: { label: 'Show sites', onClick: () => undefined },
                })
              }
            >
              Danger
            </Button>
            <Button variant="secondary" onClick={() => toast.show({ title: 'Saved' })}>
              Neutral
            </Button>
          </div>
        </Section>
      </div>

      <Sheet
        open={bottomSheet}
        onClose={() => setBottomSheet(false)}
        title="Choose a site"
        description="Only active sites within range can accept a punch."
        footer={
          <>
            <Button variant="secondary" onClick={() => setBottomSheet(false)}>
              Cancel
            </Button>
            <Button onClick={() => setBottomSheet(false)}>Confirm</Button>
          </>
        }
      >
        <List>
          <li>
            <ListItem
              interactive
              title="Riyadh HQ"
              description="1 King Fahd Road"
              trailing="42 m"
              chevron
            />
          </li>
          <li>
            <ListItem
              interactive
              title="Jeddah Branch"
              description="Al Andalus District"
              trailing="1.4 km"
              chevron
            />
          </li>
        </List>
      </Sheet>

      <Sheet
        open={centerSheet}
        placement="center"
        onClose={() => setCenterSheet(false)}
        title="Suspend Bilal Khan?"
        description="They will be signed out and cannot check in until reactivated."
        footer={
          <>
            <Button variant="secondary" onClick={() => setCenterSheet(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => setCenterSheet(false)}>
              Suspend
            </Button>
          </>
        }
      />
    </div>
  );
}
