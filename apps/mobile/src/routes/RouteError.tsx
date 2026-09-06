import { isRouteErrorResponse, useNavigate, useRouteError } from 'react-router-dom';
import { isOffline, toDisplayMessage } from '../api';
import { AlertIcon, Button, EmptyState } from '../design';
import styles from './CenteredScreen.module.css';

/**
 * Last line of defence for a render or loader failure.
 *
 * It distinguishes "you are offline" from "this broke", because the two need
 * different actions: retry versus go back. A single generic "something went
 * wrong" screen makes a flaky connection look like a broken app.
 */
export function RouteError() {
  const error = useRouteError();
  const navigate = useNavigate();

  const routeStatus = isRouteErrorResponse(error) ? error.status : null;
  const offline = isOffline(error);

  return (
    <div className={styles.screen}>
      <EmptyState
        tone="danger"
        icon={<AlertIcon size="1.65rem" />}
        title={offline ? 'You appear to be offline' : 'Something went wrong'}
        description={
          routeStatus === 404
            ? 'That page does not exist.'
            : offline
              ? 'Reconnect and try again — nothing has been lost.'
              : toDisplayMessage(error)
        }
        action={
          <Button variant="secondary" onClick={() => void navigate(0)}>
            Try again
          </Button>
        }
      />
    </div>
  );
}
