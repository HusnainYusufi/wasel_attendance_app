/**
 * Public surface of the design system.
 *
 * Screens import from `@/design` and nothing deeper. Anything not re-exported
 * here is internal and may change without notice.
 */

// Primitives
export { Button, type ButtonProps } from './components/Button/Button';
export {
  buttonClassNames,
  type ButtonSize,
  type ButtonVariant,
} from './components/Button/button-styles';
export { IconButton, type IconButtonProps } from './components/Button/IconButton';
export { Input, type InputProps } from './components/Input/Input';
export { Select, type SelectProps } from './components/Input/Select';
export {
  Card,
  CardHeader,
  type CardPadding,
  type CardProps,
  type CardVariant,
} from './components/Card/Card';
export { Sheet, type SheetProps } from './components/Sheet/Sheet';
export { Spinner, type SpinnerProps } from './components/Spinner/Spinner';
export { Skeleton, type SkeletonProps } from './components/Skeleton/Skeleton';
export { EmptyState, type EmptyStateProps } from './components/EmptyState/EmptyState';
export {
  Badge,
  type BadgeProps,
  type BadgeTone,
  type BadgeVariant,
} from './components/Badge/Badge';
export {
  SegmentedControl,
  type SegmentedControlProps,
  type SegmentedOption,
} from './components/SegmentedControl/SegmentedControl';
export { Avatar, type AvatarProps, type AvatarSize } from './components/Avatar/Avatar';
export { initialsFrom } from './components/Avatar/initials';
export { List, ListItem, type ListItemProps, type ListProps } from './components/ListItem/ListItem';

// Toast
export { ToastProvider } from './components/Toast/ToastProvider';
export { useToast } from './components/Toast/useToast';
export type { ToastOptions, ToastTone } from './components/Toast/toast-context';

// Layout
export { AppShell, type AppShellProps, type TabItem } from './layout/AppShell';
export { Screen, type ScreenProps } from './layout/Screen';
export { Splash } from './layout/Splash';
export { Logo, type LogoProps } from './layout/Logo';

// Theme
export { ThemeProvider } from './theme/ThemeProvider';
export { useTheme } from './theme/useTheme';
export type { ResolvedTheme, ThemePreference } from './theme/theme-context';

// Hooks
export {
  useFocusTrap,
  useIsMounted,
  useMediaQuery,
  usePrefersReducedMotion,
  useScrollLock,
} from './hooks';

// Utilities & icons
export { cx } from './utils/cx';
export * from './icons';
