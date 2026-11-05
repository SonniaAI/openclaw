import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createReplyRestartRecoveryClaimController } from "./restart-recovery-claim.js";

/**
 * SON-6091 deadlock reproduction (2026.10.9 port): a cross-restart orphaned armed
 * restart-recovery claim — the entry's writer/lifecycle/claim runs are all gone in
 * this process generation and the persisted status is non-terminal (2026.10.9 only
 * persists terminal top-level statuses, so the live shape is status undefined) —
 * must admit a new turn through the ordinary claim-supersede path instead of
 * refusing forever. This file only imports pre-fix APIs so the baseline (release
 * source + tests) fails on BEHAVIOR: pre-fix, admitUserTurn throws
 * "restart recovery claim changed before agent adoption" and the session stays
 * deadlocked.
 */
describe("SON-6091 restart-recovery claim orphan supersede", () => {
  it("admits a new turn against a stale cross-restart non-terminal entry and retires the orphaned claim", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:son6091-deadlock",
        storePath: state.statePath("sessions.json"),
      };
      const entry: InternalSessionEntry = {
        sessionId: "ses-6091",
        updatedAt: 1,
        status: undefined,
        activeWriterRunId: "dead-writer-run",
        lifecycleRunId: "dead-writer-run",
        restartRecoveryDeliveryRunId: "dead-claim-run",
        restartRecoveryDeliverySourceRunId: "dead-source-turn",
        startedAt: 1,
      } as InternalSessionEntry;
      await replaceSessionEntry(scope, entry);
      const controller = createReplyRestartRecoveryClaimController({
        agentId: "main",
        sessionKey: scope.sessionKey,
        storePath: scope.storePath,
        admissionRunId: "new-admission-run",
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        getEntry: () => undefined,
        getSessionId: () => entry.sessionId,
        isRestartAbort: () => false,
        resolveDeliveryContext: () => undefined,
        setEntry: () => {},
      });
      await expect(controller.admitUserTurn()).resolves.toBe("admitted");
      const stored = loadSessionEntry(scope);
      expect(stored?.restartRecoveryDeliveryRunId).toBeUndefined();
      expect(stored?.restartRecoveryTerminalRunIds ?? []).toContain("dead-source-turn");
    });
  });

  it("keeps the historical refusal when the writer run is still live", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:son6091-deadlock-live",
        storePath: state.statePath("sessions.json"),
      };
      const entry: InternalSessionEntry = {
        sessionId: "ses-6091-live",
        updatedAt: 1,
        status: undefined,
        activeWriterRunId: "live-writer-run",
        lifecycleRunId: "live-writer-run",
        restartRecoveryDeliveryRunId: "dead-claim-run",
        restartRecoveryDeliverySourceRunId: "dead-source-turn",
        startedAt: 1,
      } as InternalSessionEntry;
      await replaceSessionEntry(scope, entry);
      const { registerAgentRunContext } = await import("../../infra/agent-run-registry.js");
      registerAgentRunContext("live-writer-run", {
        sessionKey: scope.sessionKey,
        sessionId: entry.sessionId,
        projectSessionActive: true,
      });
      const controller = createReplyRestartRecoveryClaimController({
        agentId: "main",
        sessionKey: scope.sessionKey,
        storePath: scope.storePath,
        admissionRunId: "new-admission-run",
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        getEntry: () => undefined,
        getSessionId: () => entry.sessionId,
        isRestartAbort: () => false,
        resolveDeliveryContext: () => undefined,
        setEntry: () => {},
      });
      await expect(controller.admitUserTurn()).rejects.toThrow(
        "restart recovery claim changed before agent adoption",
      );
    });
  });
});
