import { useState } from 'react';
import { cx } from '../../utils/cx';
import { initialsFrom, tintIndex } from './initials';
import styles from './Avatar.module.css';

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

export interface AvatarProps {
  /** Used for the initials, the tint and the accessible name. */
  name: string;
  /**
   * A displayable image URL — in practice an object URL, because the avatar
   * route is authenticated and an `<img>` cannot carry a bearer token. Falls
   * back to initials when absent *or* when the image fails to load.
   */
  src?: string | null;
  size?: AvatarSize;
  className?: string;
}

const TINTS = [styles.tint0, styles.tint1, styles.tint2, styles.tint3, styles.tint4, styles.tint5];

export function Avatar({ name, src, size = 'md', className }: AvatarProps) {
  const tint = TINTS[tintIndex(name, TINTS.length)] ?? TINTS[0];

  /**
   * An object URL can be revoked out from under a rendered `<img>` — that is
   * what happens the moment a picture is replaced — and a broken image renders
   * as an empty plate with no clue why. Falling back to the initials keeps the
   * component readable in every failure the caller cannot prevent.
   *
   * Reset on the *changing* edge, adjusted during render rather than in an
   * effect: an effect would leave one painted frame showing the initials for a
   * new picture that is about to load perfectly well.
   */
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [lastSrc, setLastSrc] = useState(src);
  if (src !== lastSrc) {
    setLastSrc(src);
    setFailedSrc(null);
  }

  const showImage = Boolean(src) && failedSrc !== src;

  return (
    <span
      className={cx(styles.avatar, styles[size], !showImage && tint, className)}
      // The name is nearly always repeated in adjacent text; announcing it twice
      // is noise, so the avatar carries a title for pointer users and stays out
      // of the accessibility tree.
      title={name}
      aria-hidden="true"
    >
      {showImage ? (
        <img
          className={styles.image}
          src={src as string}
          alt=""
          loading="lazy"
          onError={() => setFailedSrc(src ?? null)}
        />
      ) : (
        initialsFrom(name)
      )}
    </span>
  );
}
