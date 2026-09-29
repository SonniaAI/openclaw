// SON-4330 regression: a config-reload restart deferred past its deferral
// window must still receive a nonzero drain budget measured from the
// forced-restart decision point, and a deadline exit on a planned restart is a
// clean successor handoff rather than a failed process.
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_MIN_DRAIN_BUDGET_MS,
  GATEWAY_RESTART_REPLACEMENT_TIMEOUT_MS,
  GATEWAY_SHUTDOWN_RESERVE_MS,
  GATEWAY_SUPERVISOR_EXIT_MARGIN_MS,
} from "../../infra/gateway-shutdown-budget.js";
import {
  resolveGatewayMinDrainBudgetMs,
  resolveGatewayRestartDeferralTimeoutMs,
  resolveGatewayRestartDrainTimeoutMs,
} from "../../infra/restart-budget.js";
import {
  resolveForcedShutdownExitCode,
  resolveGatewayShutdownDrainBudget,
} from "./run-loop-shutdown-budget.js";

const forcedIntent = { force: true, reason: "config reload forced restart" };
const requestedForcedDrainMs =
  GATEWAY_RESTART_REPLACEMENT_TIMEOUT_MS -
  (GATEWAY_SHUTDOWN_RESERVE_MS + GATEWAY_SUPERVISOR_EXIT_MARGIN_MS);

function deferredCloseParams(
  overrides: Partial<Parameters<typeof resolveGatewayShutdownDrainBudget>[0]> = {},
): Parameters<typeof resolveGatewayShutdownDrainBudget>[0] {
  return {
    budget: { nativeStopBudget: false, timeoutMs: 325_000, reserveMs: 10_000 },
    isRestart: true,
    forceRestart: true,
    restartWithoutSupervisor: false,
    acceptedAtMs: performance.now() - 300_463,
    requestedRestartDrainTimeoutMs: resolveGatewayRestartDrainTimeoutMs(forcedIntent),
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("SON-4330 deferred forced-restart drain budget", () => {
  it("requests the full replacement-window drain for a forced restart", () => {
    const requested = resolveGatewayRestartDrainTimeoutMs(forcedIntent);
    expect(requested).toBe(requestedForcedDrainMs);
    expect(requested).toBeGreaterThan(0);
  });

  it("keeps the requested budget nonzero when the decision carries a drain stamp", () => {
    expect(
      resolveGatewayRestartDrainTimeoutMs({ ...forcedIntent, drainStartedAtMs: performance.now() }),
    ).toBe(requestedForcedDrainMs);
  });

  it("honors an explicit exhausted attestation with a zero requested budget", () => {
    expect(
      resolveGatewayRestartDrainTimeoutMs({ ...forcedIntent, drainBudgetExhausted: true }),
    ).toBe(0);
  });

  it("measures the drain from the decision point after a 300s deferral", () => {
    const drainBudget = resolveGatewayShutdownDrainBudget(
      deferredCloseParams({ drainStartedAtMs: performance.now() - 5, minDrainBudgetMs: 15_000 }),
    );
    expect(drainBudget.restartDrainDeadlineAt).toBeDefined();
    expect(drainBudget.drainTimeoutMs).toBeGreaterThan(requestedForcedDrainMs - 1_000);
    expect(drainBudget.forceExitMs).toBeGreaterThan(0);
    expect(drainBudget.closeDrainTimeoutMs()).toBeGreaterThan(0);
  });

  it("floors a drain measured from reload acceptance instead of entering at 0ms", () => {
    const drainBudget = resolveGatewayShutdownDrainBudget(
      deferredCloseParams({ minDrainBudgetMs: 15_000 }),
    );
    expect(drainBudget.drainTimeoutMs).toBe(15_000);
  });

  it("honors an explicit exhausted attestation despite the floor", () => {
    const drainBudget = resolveGatewayShutdownDrainBudget(
      deferredCloseParams({ requestedRestartDrainTimeoutMs: 0, minDrainBudgetMs: 15_000 }),
    );
    expect(drainBudget.drainTimeoutMs).toBe(0);
  });

  it("floors with the configured default when no explicit floor is passed", () => {
    const drainBudget = resolveGatewayShutdownDrainBudget(deferredCloseParams());
    expect(drainBudget.drainTimeoutMs).toBe(GATEWAY_MIN_DRAIN_BUDGET_MS);
    expect(resolveGatewayMinDrainBudgetMs()).toBe(GATEWAY_MIN_DRAIN_BUDGET_MS);
  });
});

describe("SON-4330 env-sized restart knobs", () => {
  it("honors positive overrides for the sizing knobs", () => {
    vi.stubEnv("OPENCLAW_RESTART_DEFERRAL_TIMEOUT_MS", "600000");
    vi.stubEnv("OPENCLAW_RESTART_REPLACEMENT_TIMEOUT_MS", "90000");
    vi.stubEnv("OPENCLAW_MIN_DRAIN_BUDGET_MS", "20000");
    expect(resolveGatewayRestartDeferralTimeoutMs()).toBe(600_000);
    expect(resolveGatewayRestartDrainTimeoutMs(forcedIntent)).toBe(75_000);
    expect(resolveGatewayMinDrainBudgetMs()).toBe(20_000);
  });

  it("falls back to the defaults on invalid overrides", () => {
    vi.stubEnv("OPENCLAW_RESTART_DEFERRAL_TIMEOUT_MS", "not-a-number");
    vi.stubEnv("OPENCLAW_MIN_DRAIN_BUDGET_MS", "-5");
    expect(resolveGatewayRestartDeferralTimeoutMs()).toBe(300_000);
    expect(resolveGatewayMinDrainBudgetMs()).toBe(GATEWAY_MIN_DRAIN_BUDGET_MS);
  });
});

describe("SON-4330 forced-shutdown exit code", () => {
  it("exits cleanly when a planned restart exhausts its drain budget", () => {
    expect(
      resolveForcedShutdownExitCode({
        isRestart: true,
        nativeStopBudget: false,
        restartWithoutSupervisor: false,
        shutdownFailure: false,
      }),
    ).toBe(0);
  });

  it("still fails supervisor-less restarts, stops without a native budget, and real shutdown failures", () => {
    expect(
      resolveForcedShutdownExitCode({
        isRestart: false,
        nativeStopBudget: false,
        restartWithoutSupervisor: false,
        shutdownFailure: false,
      }),
    ).toBe(1);
    expect(
      resolveForcedShutdownExitCode({
        isRestart: true,
        nativeStopBudget: false,
        restartWithoutSupervisor: true,
        shutdownFailure: false,
      }),
    ).toBe(1);
    expect(
      resolveForcedShutdownExitCode({
        isRestart: true,
        nativeStopBudget: true,
        restartWithoutSupervisor: false,
        shutdownFailure: true,
      }),
    ).toBe(1);
  });
});
