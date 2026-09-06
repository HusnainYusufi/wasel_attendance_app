import { cx } from '../../utils/cx';
import { initialsFrom, tintIndex } from './initials';
import styles from './Avatar.module.css';

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

export interface AvatarProps {
  /** Used for the initials, the tint and the accessible name. */
  name: string;
  src?: string | null;
  size?: AvatarSize;
  className?: string;
}

const TINTS = [styles.tint0, styles.tint1, styles.tint2, styles.tint3, styles.tint4, styles.tint5];

export function Avatar({ name, src, size = 'md', className }: AvatarProps) {
  const tint = TINTS[tintIndex(name, TINTS.length)] ?? TINTS[0];

  return (
    <span
      className={cx(styles.avatar, styles[size], !src && tint, className)}
      // The name is nearly always repeated in adjacent text; announcing it twice
      // is noise, so the avatar carries a title for pointer users and stays out
      // of the accessibility tree.
      title={name}
      aria-hidden="true"
    >
      {src ? <img className={styles.image} src={src} alt="" loading="lazy" /> : initialsFrom(name)}
    </span>
  );
}
