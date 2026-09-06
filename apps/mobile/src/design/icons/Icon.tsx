import type { ReactNode, SVGProps } from 'react';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  /** Edge length in `em`, so an icon scales with the text it sits beside. */
  size?: number | string;
  /** Accessible name. Omit for icons that merely decorate adjacent text. */
  title?: string;
}

/**
 * Shared chrome for the icon set: a 24-unit grid, round joins, `currentColor`
 * fills, and `aria-hidden` unless the caller supplies a title. Stroke width is
 * 1.75 — 2 is heavy at 16px and 1.5 disappears in direct sunlight.
 */
export function IconBase({
  size = '1.25em',
  title,
  children,
  ...rest
}: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}
