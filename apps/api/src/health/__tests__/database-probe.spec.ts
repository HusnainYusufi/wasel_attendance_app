import { describe, expect, it, vi } from 'vitest';
import { DATABASE_PING_TIMEOUT_MS, DatabaseProbe } from '../database-probe.js';

interface ProbeInternals {
  acquire: () => Promise<{ query: (text: string) => Promise<unknown> }>;
  release: () => Promise<void>;
}

function probeWith(query: () => Promise<unknown>): {
  probe: DatabaseProbe;
  release: ReturnType<typeof vi.fn>;
} {
  const probe = new DatabaseProbe({
    database: { url: 'postgresql://user:pw@localhost:5432/db', connectTimeoutMs: 10_000 },
  } as never);

  const release = vi.fn(() => Promise.resolve());
  const internals = probe as unknown as ProbeInternals;
  internals.acquire = () => Promise.resolve({ query });
  internals.release = release;

  return { probe, release };
}

describe('DatabaseProbe', () => {
  it('shares one in-flight query between overlapping probes', async () => {
    // A single connection can only run one query at a time; two orchestrator
    // checks arriving together must not queue on the same socket.
    const query = vi.fn(() => Promise.resolve([]));
    const { probe } = probeWith(query);

    await Promise.all([probe.ping(), probe.ping(), probe.ping()]);

    expect(query).toHaveBeenCalledTimes(1);
  });

  it('runs a fresh query once the previous one has settled', async () => {
    const query = vi.fn(() => Promise.resolve([]));
    const { probe } = probeWith(query);

    await probe.ping();
    await probe.ping();

    expect(query).toHaveBeenCalledTimes(2);
  });

  it('drops the connection when a query fails, so the next probe redials', async () => {
    const { probe, release } = probeWith(() => Promise.reject(new Error('server closed')));

    await expect(probe.ping()).rejects.toThrow('server closed');
    expect(release).toHaveBeenCalledOnce();
  });

  it('bounds the probe deadline well below an orchestrator check interval', () => {
    expect(DATABASE_PING_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });
});
