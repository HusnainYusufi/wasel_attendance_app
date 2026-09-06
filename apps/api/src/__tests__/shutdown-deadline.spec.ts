import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SHUTDOWN_DEADLINE_MS, installShutdownDeadline } from '../bootstrap.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('installShutdownDeadline', () => {
  it('kills the process when a graceful shutdown does not finish in time', () => {
    // A client trickling one byte a second keeps an in-flight request — and so
    // the shutdown — alive indefinitely. Without this the orchestrator SIGKILLs
    // instead, `onModuleDestroy` never runs, and Postgres holds the pool open
    // while the replacement pod opens its own.
    vi.useFakeTimers();
    const exit = vi.fn();
    const signals = new EventEmitter();

    installShutdownDeadline({ deadlineMs: 10_000, exit, signals });
    signals.emit('SIGTERM');

    vi.advanceTimersByTime(9_999);
    expect(exit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('arms on SIGINT as well, and only once', () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const signals = new EventEmitter();

    installShutdownDeadline({ deadlineMs: 1_000, exit, signals });
    signals.emit('SIGINT');
    signals.emit('SIGTERM');
    signals.emit('SIGINT');

    vi.advanceTimersByTime(5_000);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('does not hold the process open on its own', () => {
    vi.useFakeTimers();
    const signals = new EventEmitter();
    const unref = vi.spyOn(globalThis, 'setTimeout');

    installShutdownDeadline({ deadlineMs: 1_000, exit: () => undefined, signals });
    signals.emit('SIGTERM');

    const timer = unref.mock.results[0]?.value as { hasRef?: () => boolean } | undefined;
    expect(timer?.hasRef?.()).toBe(false);
    unref.mockRestore();
  });

  it('detaches its listeners when disposed', () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const signals = new EventEmitter();

    const dispose = installShutdownDeadline({ deadlineMs: 1_000, exit, signals });
    dispose();
    expect(signals.listenerCount('SIGTERM')).toBe(0);

    signals.emit('SIGTERM');
    vi.advanceTimersByTime(5_000);
    expect(exit).not.toHaveBeenCalled();
  });

  it('defaults to a deadline shorter than a Kubernetes grace period', () => {
    // The process must decide to give up before the orchestrator SIGKILLs it,
    // otherwise the deadline buys nothing.
    expect(SHUTDOWN_DEADLINE_MS).toBeLessThan(30_000);
  });
});
