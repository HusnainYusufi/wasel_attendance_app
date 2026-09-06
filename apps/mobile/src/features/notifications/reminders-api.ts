import type { ReminderScheduleDto } from '@wasel/contracts';
import { apiClient } from '../../api';

/**
 * The one reminders route, bound the same way every other resource is.
 *
 * Declared inside this feature rather than in `src/api/resources.ts` on purpose:
 * reminders are self-contained, nothing outside this folder calls the endpoint,
 * and keeping it here means the feature can be added or removed without touching
 * a file every other screen imports. The transport, the auth header, the refresh
 * dance and the error envelope are all still `apiClient`'s — no component here
 * goes near `fetch`.
 */
export const remindersApi = {
  schedule: (signal?: AbortSignal): Promise<ReminderScheduleDto> =>
    apiClient.request<ReminderScheduleDto>('/reminders/schedule', { signal }),
};
