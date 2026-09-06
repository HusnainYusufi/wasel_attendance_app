import type { CSSProperties } from 'react';
import { cx } from '../../utils/cx';
import styles from './Skeleton.module.css';

export interface SkeletonProps {
  /** `text` sizes itself from the surrounding font so lines land on the grid. */
  shape?: 'text' | 'rect' | 'rounded' | 'circle';
  width?: string | number;
  height?: string | number;
  className?: string;
  style?: CSSProperties;
}

const SHAPE = {
  text: styles.text,
  rect: undefined,
  rounded: styles.rounded,
  circle: styles.circle,
} as const;

export function Skeleton({ shape = 'text', width, height, className, style }: SkeletonProps) {
  return (
    <span
      // The container that owns the skeleton carries aria-busy; the placeholder
      // itself is pure decoration and must not be announced.
      aria-hidden="true"
      className={cx(styles.skeleton, SHAPE[shape], className)}
      style={{ width, height, ...style }}
    />
  );
}
