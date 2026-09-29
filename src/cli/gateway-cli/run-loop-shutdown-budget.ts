import { performance } from "node:perf_hooks";
import { LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS } from "../../daemon/launchd-plist.js";
import {
  GATEWAY_SERVICE_STOP_TIMEOUT_MS,
  GATEWAY_SHUTDOWN_RESERVE_MS,
  GATEWAY_SHUTDOWN_TIMEOUT_MS,
  GATEWAY_SUPERVISOR_EXIT_MARGIN_MS,
} from "../../infra/gateway-shutdown-budget.js";
import { readSystemdStopTimeout } from "../../infra/systemd-stop-timeout.js";
import { resolveGatewayMinDrainBudgetMs } from "../../infra/restart-budget.js";

export async function resolveGatewayShutdownBudget(
  supervisor: string | null,
  logger: { info(message: string): void; warn(message: string): void },
  refresh?: {
    previous: { timeoutMs: number; nativeStopBudget: boolean };
    acceptedAtMs: number;
  },
) {
  // Restart ownership may be external while systemd still enforces the stop deadline.
  const systemdStop = process.platform === "linux" ? await readSystemdStopTimeout() : null;
  const retained =
    refresh?.previous.nativeStopBudget && (!systemdStop || systemdStop.warning)
      ? refresh.previous
      : undefined;
  if (systemdStop?.warning) {
    logger.warn(systemdStop.warning);
  }
  if (retained) {
    logger.warn(
      `Retaining the startup shutdown budget of ${retained.timeoutMs}ms because the current systemd stop timeout could not be confirmed.`,
    );
  }
  const stop = systemdStop ?? {
    timeoutMs:
      supervisor === "launchd"
        ? LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS * 1_000
        : GATEWAY_SERVICE_STOP_TIMEOUT_MS,
    source: supervisor === "launchd" ? "launchd ExitTimeOut" : "Gateway stop policy",
  };
  const nativeStopBudget = systemdStop !== null || supervisor === "launchd" || Boolean(retained);
  const limitMs =
    retained?.timeoutMs ??
    Math.min(GATEWAY_SHUTDOWN_TIMEOUT_MS, stop.timeoutMs - GATEWAY_SUPERVISOR_EXIT_MARGIN_MS);
  const elapsedMs =
    refresh && nativeStopBudget
      ? Math.max(0, Math.ceil(performance.now() - refresh.acceptedAtMs))
      : 0;
  const timeoutMs = Math.max(0, limitMs - elapsedMs);
  const reserveMs = Math.min(GATEWAY_SHUTDOWN_RESERVE_MS, timeoutMs);
  return {
    nativeStopBudget,
    timeoutMs,
    reserveMs,
    // Let cleanup failures reach the run loop before its native exit timer wins.
    cleanupBudget: (deadline: number | undefined, hardExitGraceMs: number) =>
      deadline === undefined
        ? undefined
        : {
            deadline:
              deadline -
              Math.min(hardExitGraceMs / 2, Math.max(0, deadline - performance.now()) / 2),
            warn: (message: string) => logger.warn(message),
          },
    log: (phase: "startup" | "shutdown") => {
      logger.info(
        `shutdown budget at ${phase}: drain=${Math.max(0, timeoutMs - GATEWAY_SHUTDOWN_RESERVE_MS)}ms shutdown=${timeoutMs}ms reserve=${reserveMs}ms exitMargin=${GATEWAY_SUPERVISOR_EXIT_MARGIN_MS}ms; source=${retained ? `startup shutdown budget=${retained.timeoutMs}ms` : `${stop.source}=${stop.timeoutMs}ms`}`,
      );
    },
  };
}

export function resolveGatewayShutdownDrainBudget(params: {
  budget: { nativeStopBudget: boolean; timeoutMs: number; reserveMs: number };
  isRestart: boolean;
  forceRestart: boolean;
  restartWithoutSupervisor: boolean;
  acceptedAtMs: number;
  /** SON-4330: monotonic stamp of the forced-restart decision point. When present, the requested restart drain budget is measured from this instant instead of reload acceptance, so a deferred restart keeps its full cleanup budget. */
  drainStartedAtMs?: number;
  /** SON-4330: nonzero floor for a requested drain budget starved to zero by pre-close waiting; shutdown must never enter with 0ms of cleanup. */
  minDrainBudgetMs?: number;
  requestedRestartDrainTimeoutMs?: number;
}) {
  const { budget, isRestart } = params;
  const requested = params.requestedRestartDrainTimeoutMs;
  const drainAnchorMs = params.drainStartedAtMs ?? params.acceptedAtMs;
  const elapsedMs = performance.now() - drainAnchorMs;
  const rawRemaining = requested === undefined ? undefined : Math.max(0, requested - elapsedMs);
  // SON-4330: a requested budget starved to zero by pre-close waiting (deferral
  // window, emission retries) is floored to a nonzero cleanup budget. An
  // explicit exhausted attestation (requested === 0) is honored as-is.
  const remaining =
    rawRemaining === 0 && requested !== undefined && requested > 0
      ? (params.minDrainBudgetMs ?? resolveGatewayMinDrainBudgetMs())
      : rawRemaining;
  const restartDrainTimeoutMs = budget.nativeStopBudget
    ? Math.min(remaining ?? Infinity, Math.max(0, budget.timeoutMs - budget.reserveMs))
    : remaining;
  const restartDrainDeadlineAt =
    isRestart && restartDrainTimeoutMs !== undefined
      ? Date.now() + restartDrainTimeoutMs
      : undefined;
  const forcedRestartDeadlineAt =
    params.forceRestart && restartDrainDeadlineAt !== undefined
      ? restartDrainDeadlineAt + budget.reserveMs
      : undefined;
  const restartTimeoutMs = (drainTimeoutMs: number) => {
    if (forcedRestartDeadlineAt !== undefined) {
      return Math.max(0, forcedRestartDeadlineAt - Date.now());
    }
    // A containing service can bound an in-process restart without replacing it.
    return budget.nativeStopBudget && params.restartWithoutSupervisor
      ? budget.timeoutMs
      : drainTimeoutMs + (budget.nativeStopBudget ? budget.reserveMs : GATEWAY_SHUTDOWN_TIMEOUT_MS);
  };
  return {
    restartDrainDeadlineAt,
    restartTimeoutMs: () =>
      budget.nativeStopBudget || params.forceRestart
        ? restartTimeoutMs(Math.max(0, (restartDrainDeadlineAt ?? Date.now()) - Date.now()))
        : GATEWAY_SHUTDOWN_TIMEOUT_MS,
    closeDrainTimeoutMs: () =>
      restartDrainTimeoutMs === undefined
        ? GATEWAY_SHUTDOWN_TIMEOUT_MS - budget.reserveMs
        : Math.max(0, (restartDrainDeadlineAt ?? Date.now()) - Date.now()),
    drainTimeoutMs: isRestart
      ? restartDrainTimeoutMs
      : Math.max(0, budget.timeoutMs - budget.reserveMs),
    forceExitMs: !isRestart
      ? budget.timeoutMs
      : restartDrainTimeoutMs === undefined
        ? undefined
        : restartTimeoutMs(restartDrainTimeoutMs),
  };
}

/** SON-4330: exit code when an armed shutdown deadline fires. A planned restart
 * that exhausts its (nonzero) drain budget is a successful handoff to the
 * supervisor replacement rather than a crash: exit cleanly unless a shutdown
 * step failed, the restart has no successor process, or it is a stop without a
 * confirmed native stop budget. */
export function resolveForcedShutdownExitCode(params: {
  isRestart: boolean;
  nativeStopBudget: boolean;
  restartWithoutSupervisor: boolean;
  shutdownFailure: boolean;
}): 0 | 1 {
  return !params.shutdownFailure &&
    !params.restartWithoutSupervisor &&
    (params.nativeStopBudget || params.isRestart)
    ? 0
    : 1;
}
