/**
 * Shapes for the operational probes.
 *
 * Declared locally rather than in `@wasel/contracts` because these endpoints are
 * consumed by the orchestrator, not by the mobile client: they are an operations
 * surface, and freezing them into the client contract would be misleading.
 */
export interface LivenessBody {
  status: 'ok';
  uptimeSeconds: number;
  timestamp: string;
}

export interface ReadinessBody {
  status: 'ok';
  checks: { database: 'ok' };
  timestamp: string;
}
