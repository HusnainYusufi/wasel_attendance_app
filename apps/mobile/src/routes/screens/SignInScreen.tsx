import { ErrorCode } from '@wasel/contracts';
import { useRef, useState, type FormEvent } from 'react';
import { fieldErrors, isApiError, isErrorCode, isOffline, toDisplayMessage } from '../../api';
import { useAuth } from '../../auth';
import { Banner } from '../../components/Banner';
import { Button, Card, Input, Logo, MailIcon } from '../../design';
import styles from './SignInScreen.module.css';

interface FormErrors {
  email?: string;
  password?: string;
}

interface FormFailure {
  tone: 'danger' | 'warning';
  title: string;
  description?: string;
}

/**
 * Turns a sign-in failure into something the user can act on.
 *
 * Every branch is selected on `error.code`, never on the message text: the
 * server is free to localise or reword, and a client that greps for "locked"
 * silently stops recognising a lockout the day someone improves the copy.
 */
function describeFailure(error: unknown): FormFailure {
  if (isErrorCode(error, ErrorCode.INVALID_CREDENTIALS)) {
    return {
      tone: 'danger',
      title: 'Email or password is incorrect',
      description: 'Check both and try again. Repeated failures will lock the account for a while.',
    };
  }
  if (isErrorCode(error, ErrorCode.ACCOUNT_LOCKED)) {
    return {
      tone: 'warning',
      title: 'This account is temporarily locked',
      description:
        'Too many failed attempts. Wait a few minutes and try again, or ask an administrator to reset your password.',
    };
  }
  if (isErrorCode(error, ErrorCode.ACCOUNT_SUSPENDED)) {
    return {
      tone: 'warning',
      title: 'This account is suspended',
      description: 'An administrator has to reactivate it before you can sign in.',
    };
  }
  if (isErrorCode(error, ErrorCode.RATE_LIMITED)) {
    return {
      tone: 'warning',
      title: 'Too many attempts',
      description: 'Give it a minute before trying again.',
    };
  }
  if (isOffline(error)) {
    return {
      tone: 'danger',
      title: 'Cannot reach the server',
      description: 'Check your connection and try again. Your details have not been sent anywhere.',
    };
  }
  if (isApiError(error) && error.status >= 500) {
    return {
      tone: 'danger',
      title: 'The server is having trouble',
      description: 'This is not your account — try again in a moment.',
    };
  }
  return { tone: 'danger', title: 'Could not sign in', description: toDisplayMessage(error) };
}

export default function SignInScreen() {
  const { signIn } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<FormErrors>({});
  const [failure, setFailure] = useState<FormFailure | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // A second guard behind `Button loading`. A submit can also arrive from the
  // keyboard's Go key while React has not yet re-rendered the disabled button,
  // and two logins in flight would rotate each other's refresh token.
  const inFlight = useRef(false);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inFlight.current) return;

    const trimmed = email.trim();
    const next: FormErrors = {};
    if (trimmed.length === 0) next.email = 'Enter your email address.';
    if (password.length === 0) next.password = 'Enter your password.';
    setErrors(next);
    setFailure(null);
    if (Object.keys(next).length > 0) return;

    inFlight.current = true;
    setSubmitting(true);
    try {
      // No navigation here on purpose: `RequireGuest` sees the session appear
      // and redirects, which also honours the `from` deep link that sent the
      // user to sign-in in the first place.
      await signIn({ email: trimmed, password });
    } catch (error) {
      if (isErrorCode(error, ErrorCode.VALIDATION_FAILED)) {
        const detail = fieldErrors(error);
        const mapped: FormErrors = {};
        if (detail['email']) mapped.email = detail['email'];
        if (detail['password']) mapped.password = detail['password'];
        setErrors(mapped);
        if (Object.keys(mapped).length > 0) {
          setSubmitting(false);
          inFlight.current = false;
          return;
        }
      }
      setFailure(describeFailure(error));
      setSubmitting(false);
      inFlight.current = false;
      return;
    }
    // Deliberately not clearing `submitting` on success: the redirect unmounts
    // this screen, and flipping the button back to idle first shows a live
    // "Sign in" button for one frame that a fast tap could press again.
  };

  return (
    <div className={styles.screen}>
      <div className={styles.brand}>
        <Logo size="lg" />
        <h1 className={styles.title}>Wasel Attendance</h1>
        <p className={styles.subtitle}>Sign in to check in and out of your site.</p>
      </div>

      <Card variant="elevated" padding="lg">
        <form className={styles.form} onSubmit={onSubmit} noValidate>
          {failure ? (
            <Banner tone={failure.tone} title={failure.title} description={failure.description} />
          ) : null}

          <Input
            label="Email"
            type="email"
            size="lg"
            required
            value={email}
            error={errors.email}
            onChange={(event) => setEmail(event.target.value)}
            iconStart={<MailIcon size="1.1rem" />}
            // `inputMode="email"` puts @ and . on the phone keyboard's first
            // layer; `autoComplete="username"` is what password managers key on
            // for a sign-in pair — "email" alone stops many of them offering the
            // saved password below.
            inputMode="email"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="next"
            placeholder="you@company.com"
            disabled={submitting}
          />

          <Input
            label="Password"
            type="password"
            size="lg"
            required
            revealToggle
            value={password}
            error={errors.password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            disabled={submitting}
          />

          <Button type="submit" size="lg" fullWidth loading={submitting}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </Card>

      <p className={styles.footer}>
        Trouble signing in? Your organization&rsquo;s administrator can reset your password.
      </p>
    </div>
  );
}
