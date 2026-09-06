import styles from './Field.module.css';

export { styles as fieldStyles };

/**
 * Joins the ids of whichever helper texts are actually rendered.
 * Pointing `aria-describedby` at an id that does not exist makes some screen
 * readers drop the whole attribute, silencing the hint as well as the error.
 */
export function describedBy(
  hint: string | undefined,
  error: string | undefined,
  hintId: string,
  errorId: string,
): string | undefined {
  const ids: string[] = [];
  if (hint) ids.push(hintId);
  if (error) ids.push(errorId);
  return ids.length > 0 ? ids.join(' ') : undefined;
}
