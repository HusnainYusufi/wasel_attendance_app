import { SetMetadata, type CustomDecorator } from '@nestjs/common';
import { IS_PUBLIC_KEY } from './auth.constants.js';

/**
 * Opts a route (or an entire controller) out of authentication.
 *
 * Authentication is on by default via a globally registered guard; this is the
 * only way out. Defaulting the other way round is how endpoints ship unguarded.
 */
export const Public = (): CustomDecorator<string> => SetMetadata(IS_PUBLIC_KEY, true);
