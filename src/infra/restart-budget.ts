import {
  GATEWAY_MIN_DRAIN_BUDGET_MS,
  GATEWAY_RESTART_REPLACEMENT_TIMEOUT_MS,
  GATEWAY_SHUTDOWN_RESERVE_MS,
  GATEWAY_SUPERVISOR_EXIT_MARGIN_MS,
} from "./gateway-shutdown-budget.js";
import type { GatewayRestartIntent } from "./restart-intent.js";

const DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS = 300_000;

// SON-4330: restart sizing knobs are env-exposed so long-running embedded
// deployments (wake runs that legitimately outlive the defaults) can size the
// deferral window, the replacement window, and the minimum drain budget
// without a code change. Only finite positive numbers are honored; anything
// else falls back to the built-in default.
function readEnvBudgetMs(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/** SON-4330: nonzero floor applied when a requested restart drain budget was starved to zero by pre-close waiting. */
export function resolveGatewayMinDrainBudgetMs(): number {
  return readEnvBudgetMs("OPENCLAW_MIN_DRAIN_BUDGET_MS") ?? GATEWAY_MIN_DRAIN_BUDGET_MS;
}

/** SON-4330: replacement window bounding a forced-restart handoff; env-overridable for long-running embedded runs. */
export function resolveGatewayRestartReplacementTimeoutMs(): number {
  return (
    readEnvBudgetMs("OPENCLAW_RESTART_REPLACEMENT_TIMEOUT_MS") ??
    GATEWAY_RESTART_REPLACEMENT_TIMEOUT_MS
  );
}

export function resolveGatewayRestartDeferralTimeoutMs(): number;
export function resolveGatewayRestartDeferralTimeoutMs(timeoutMs: unknown): number | undefined;
export function resolveGatewayRestartDeferralTimeoutMs(timeoutMs?: unknown): number | undefined {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
    return (
      readEnvBudgetMs("OPENCLAW_RESTART_DEFERRAL_TIMEOUT_MS") ??
      DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS
    );
  }
  return timeoutMs > 0 ? Math.floor(timeoutMs) : undefined;
}

export function resolveGatewayRestartDrainTimeoutMs(intent?: GatewayRestartIntent) {
  const reserveMs = GATEWAY_SHUTDOWN_RESERVE_MS + GATEWAY_SUPERVISOR_EXIT_MARGIN_MS;
  const waitMs =
    intent?.waitMs ??
    (intent?.force ? resolveGatewayRestartReplacementTimeoutMs() - reserveMs : undefined);
  const exhausted = intent?.drainBudgetExhausted || (intent?.force && waitMs === 0);
  return exhausted ? 0 : resolveGatewayRestartDeferralTimeoutMs(waitMs);
}
