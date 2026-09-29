import { afterEach, describe, expect, it } from "vitest";
import {
  GATEWAY_RESTART_DRAIN_FLOOR_MS,
  resolveEnvGatewayRestartDeferralTimeoutMs,
  resolveGatewayRestartDeferralTimeoutMs,
  resolveGatewayRestartDrainTimeoutMs,
} from "./restart-budget.js";

const DEFERRAL_ENV = "OPENCLAW_GATEWAY_RESTART_DEFERRAL_TIMEOUT_MS";

describe("gateway restart budget (SON-4330)", () => {
  it("grants forced restarts the replacement window minus reserves", () => {
    expect(resolveGatewayRestartDrainTimeoutMs({ force: true })).toBe(45_000);
  });

  it("floors the drain budget on deferral exhaustion instead of 0ms cleanup", () => {
    const drained = resolveGatewayRestartDrainTimeoutMs({
      force: true,
      drainBudgetExhausted: true,
    });
    expect(drained).toBe(GATEWAY_RESTART_DRAIN_FLOOR_MS);
    expect(drained).toBeGreaterThan(0);
  });

  it("defaults the deferral timeout to 300s and accepts explicit overrides", () => {
    expect(resolveGatewayRestartDeferralTimeoutMs()).toBe(300_000);
    expect(resolveGatewayRestartDeferralTimeoutMs(45_000)).toBe(45_000);
    expect(resolveGatewayRestartDeferralTimeoutMs(0)).toBeUndefined();
    expect(resolveGatewayRestartDeferralTimeoutMs("nonsense")).toBeUndefined();
  });

  it("sizes the deferral timeout from the environment when provided", () => {
    const previous = process.env[DEFERRAL_ENV];
    try {
      delete process.env[DEFERRAL_ENV];
      expect(resolveEnvGatewayRestartDeferralTimeoutMs()).toBeUndefined();
      process.env[DEFERRAL_ENV] = "120000";
      expect(resolveEnvGatewayRestartDeferralTimeoutMs()).toBe(120_000);
      process.env[DEFERRAL_ENV] = "0";
      expect(resolveEnvGatewayRestartDeferralTimeoutMs()).toBeUndefined();
      process.env[DEFERRAL_ENV] = "not-a-number";
      expect(resolveEnvGatewayRestartDeferralTimeoutMs()).toBeUndefined();
    } finally {
      if (previous === undefined) {
        delete process.env[DEFERRAL_ENV];
      } else {
        process.env[DEFERRAL_ENV] = previous;
      }
    }
  });
});
