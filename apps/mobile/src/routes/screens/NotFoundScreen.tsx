import { Link } from 'react-router-dom';
import { buttonClassNames, EmptyState, SearchIcon } from '../../design';
import { paths } from '../paths';
import styles from '../CenteredScreen.module.css';

export default function NotFoundScreen() {
  return (
    <div className={styles.screen}>
      <EmptyState
        icon={<SearchIcon size="1.65rem" />}
        title="Page not found"
        description="That link does not lead anywhere in this app."
        action={
          <Link to={paths.home} className={buttonClassNames({ variant: 'secondary' })}>
            Back to today
          </Link>
        }
      />
    </div>
  );
}
