import {
  GATEWAY_RESTART_REPLACEMENT_TIMEOUT_MS,
  GATEWAY_SHUTDOWN_RESERVE_MS,
  GATEWAY_SUPERVISOR_EXIT_MARGIN_MS,
} from "./gateway-shutdown-budget.js";
import type { GatewayRestartIntent } from "./restart-intent.js";

const DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS = 300_000;

// Never enter shutdown with a 0ms cleanup budget (SON-4330): a forced restart
// that already waited out its deferral still gets at least this much drain.
export const GATEWAY_RESTART_DRAIN_FLOOR_MS =
  GATEWAY_SHUTDOWN_RESERVE_MS + GATEWAY_SUPERVISOR_EXIT_MARGIN_MS;

/**
 * Non-hardcoded sizing for the restart deferral waiter (SON-4330): operators
 * running long embedded workloads can size it via
 * OPENCLAW_GATEWAY_RESTART_DEFERRAL_TIMEOUT_MS (ms, > 0).
 */
export function resolveEnvGatewayRestartDeferralTimeoutMs(): number | undefined {
  const raw = process.env.OPENCLAW_GATEWAY_RESTART_DEFERRAL_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

export function resolveGatewayRestartDeferralTimeoutMs(): number;
export function resolveGatewayRestartDeferralTimeoutMs(timeoutMs: unknown): number | undefined;
export function resolveGatewayRestartDeferralTimeoutMs(timeoutMs?: unknown): number | undefined {
  // No override: use the default. An explicit-but-invalid override resolves to
  // undefined (never silently the default) so callers cannot accidentally
  // stretch the deferral by passing malformed values (SON-4330).
  if (timeoutMs === undefined) {
    return DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS;
  }
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return undefined;
  }
  return Math.floor(timeoutMs);
}

export function resolveGatewayRestartDrainTimeoutMs(intent?: GatewayRestartIntent) {
  const reserveMs = GATEWAY_SHUTDOWN_RESERVE_MS + GATEWAY_SUPERVISOR_EXIT_MARGIN_MS;
  const waitMs =
    intent?.waitMs ??
    (intent?.force ? GATEWAY_RESTART_REPLACEMENT_TIMEOUT_MS - reserveMs : undefined);
  const exhausted = intent?.drainBudgetExhausted || (intent?.force && waitMs === 0);
  // Floor the drain budget: a forced restart never enters shutdown with 0ms of
  // cleanup (SON-4330). Safe abandon of NEW work is preferred over aborting
  // in-flight cleanup; the supervisor's replacement owns the failover.
  if (exhausted) {
    return GATEWAY_RESTART_DRAIN_FLOOR_MS;
  }
  return resolveGatewayRestartDeferralTimeoutMs(waitMs);
}
