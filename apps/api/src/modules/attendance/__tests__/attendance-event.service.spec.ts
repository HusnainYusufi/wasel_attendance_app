import { Logger } from '@nestjs/common';
import { PunchOutcome, PunchType, Role } from '@wasel/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../../prisma/prisma.service.js';
import {
  ATTENDANCE_AUDIT_DROPPED,
  AttendanceEventService,
  type PunchAttempt,
} from '../attendance-event.service.js';

const ATTEMPT: PunchAttempt = {
  auth: {
    userId: '55555555-5555-4555-8555-555555555555',
    organizationId: '44444444-4444-4444-8444-444444444444',
    role: Role.MEMBER,
    tokenVersion: 0,
  },
  type: PunchType.CHECK_IN,
  outcome: PunchOutcome.REJECTED_OUT_OF_RANGE,
  workDate: '2026-03-01',
  latitude: 24.7136,
  longitude: 46.6753,
  accuracyM: 8,
  nearest: null,
  deviceTime: null,
  client: { ipAddress: '203.0.113.7', userAgent: 'vitest' },
};

function harness(create: ReturnType<typeof vi.fn>): AttendanceEventService {
  return new AttendanceEventService({
    attendanceEvent: { create },
  } as unknown as PrismaService);
}

describe('recording a rejected punch', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('writes the row', async () => {
    const create = vi.fn().mockResolvedValue({});

    await harness(create).record(ATTEMPT);

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      data: { outcome: PunchOutcome.REJECTED_OUT_OF_RANGE, latitude: 24.7136 },
    });
  });

  it('retries once, because a rejection has no transaction to fail with', async () => {
    // An accepted punch commits its event inside the record's transaction and is
    // genuinely atomic. A rejection cannot be, so the fail-open half of
    // CONVENTIONS §2.5 is where a dropped audit row actually happens — and a
    // pool hiccup or a lock timeout clears on a second attempt.
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValue({});
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await harness(create).record(ATTEMPT);

    expect(create).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('gives up after the retry, loudly and with the whole row', async () => {
    const create = vi.fn().mockRejectedValue(new Error('table is gone'));
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await harness(create).record(ATTEMPT);

    expect(create).toHaveBeenCalledTimes(2);
    // A stable marker, so alerting keys on the event rather than on prose, and
    // the row itself, so what the auditor lost is reconstructable from the log.
    const [context] = error.mock.calls[0] ?? [];
    expect(context).toMatchObject({
      event: ATTENDANCE_AUDIT_DROPPED,
      row: { outcome: PunchOutcome.REJECTED_OUT_OF_RANGE },
    });
  });

  it('never throws, so a failed audit cannot change the answer the client gets', async () => {
    const create = vi.fn().mockRejectedValue(new Error('table is gone'));
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await expect(harness(create).record(ATTEMPT)).resolves.toBeUndefined();
  });
});
