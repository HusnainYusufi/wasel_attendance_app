import { useCallback, useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from '../../utils/cx';
import styles from './SegmentedControl.module.css';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Rendered small and dimmed after the label — e.g. a result count. */
  meta?: ReactNode;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  /** Names the group for assistive tech; there is no visible legend. */
  label: string;
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  fullWidth?: boolean;
  className?: string;
}

/**
 * `radiogroup` semantics, not `tablist`: these options filter the content below
 * rather than swap between panels, and a radio group is what a screen reader
 * user expects to answer with arrow keys.
 *
 * Roving tabindex — only the selected option is tabbable, and Arrow keys move
 * both focus and selection — matches the platform behaviour of a native radio
 * group, so Tab never has to walk through five segments to leave the control.
 */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  fullWidth = false,
  className,
}: SegmentedControlProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );

  const move = useCallback(
    (delta: number) => {
      const count = options.length;
      if (count === 0) return;
      let next = selectedIndex;
      for (let step = 0; step < count; step += 1) {
        next = (next + delta + count) % count;
        const candidate = options[next];
        if (candidate && !candidate.disabled) {
          onChange(candidate.value);
          const buttons =
            containerRef.current?.querySelectorAll<HTMLButtonElement>('button[role="radio"]');
          buttons?.[next]?.focus();
          return;
        }
      }
    },
    [onChange, options, selectedIndex],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        move(1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        move(-1);
        break;
      case 'Home':
        event.preventDefault();
        move(-selectedIndex);
        break;
      case 'End':
        event.preventDefault();
        move(options.length - 1 - selectedIndex);
        break;
      default:
        break;
    }
  };

  const style = {
    '--seg-count': options.length,
    '--seg-index': selectedIndex,
    '--seg-gap': 'var(--space-1)',
  } as CSSProperties;

  return (
    <div
      ref={containerRef}
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      style={style}
      className={cx(styles.root, fullWidth && styles.fullWidth, className)}
    >
      <span className={styles.thumb} aria-hidden="true" />
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
            className={cx(styles.option, selected && styles.selected)}
          >
            {option.label}
            {option.meta !== undefined ? <span className={styles.count}>{option.meta}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
