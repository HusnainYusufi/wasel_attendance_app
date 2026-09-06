import { ErrorCode } from '@wasel/contracts';
import { isErrorCode, isOffline, toDisplayMessage } from '../api';
import { AlertIcon, Button, EmptyState } from '../design';

export interface LoadFailureProps {
  error: unknown;
  onRetry?: () => void;
  /** What failed to load, e.g. `today's attendance`. Completes the sentence. */
  subject?: string;
  compact?: boolean;
}

/**
 * The one place a failed query turns into words.
 *
 * Three cases get their own copy because they need three different actions:
 * offline (reconnect and retry), forbidden (nothing to retry — the account
 * lacks the right), and everything else (retry). A single "Something went wrong"
 * with a Retry button would leave the forbidden case looping forever.
 */
export function LoadFailure({ error, onRetry, subject, compact = false }: LoadFailureProps) {
  const offline = isOffline(error);
  const forbidden = isErrorCode(error, ErrorCode.FORBIDDEN);

  const title = offline
    ? 'You appear to be offline'
    : forbidden
      ? 'You do not have access to this'
      : subject
        ? `Could not load ${subject}`
        : 'Could not load this';

  const description = offline
    ? 'Reconnect and try again — nothing has been lost.'
    : forbidden
      ? 'Ask an administrator if you think this is a mistake.'
      : toDisplayMessage(error);

  return (
    <EmptyState
      tone="danger"
      compact={compact}
      icon={<AlertIcon size="1.65rem" />}
      title={title}
      description={description}
      action={
        onRetry && !forbidden ? (
          <Button variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        ) : undefined
      }
    />
  );
}
