import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { createReplyRestartRecoveryClaimController } from "./restart-recovery-claim.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

/**
 * SON-6091 deadlock reproduction: a cross-restart "running" entry holding an armed
 * restart-recovery claim whose owning runs are gone must admit a new turn through
 * the ordinary claim-supersede path instead of refusing forever. This file only
 * imports pre-fix APIs so the baseline (release source + tests) fails on BEHAVIOR:
 * pre-fix, admitUserTurn throws "restart recovery claim changed before agent
 * adoption" and the session stays deadlocked.
 */
describe("SON-6091 restart-recovery claim orphan supersede", () => {
  it("admits a new turn against a stale cross-restart running entry and retires the orphaned claim", async () => {
    const scope = {
      agentId: "ops",
      storePath: path.join(tempDirs.make("openclaw-son6091-deadlock-"), "sessions.json"),
      sessionKey: "global",
    };
    const entry: InternalSessionEntry = {
      sessionId: "ses-6091",
      updatedAt: 1,
      status: "running",
      activeWriterRunId: "dead-writer-run",
      lifecycleRunId: "dead-writer-run",
      restartRecoveryDeliveryRunId: "dead-claim-run",
      restartRecoveryDeliverySourceRunId: "dead-source-turn",
      startedAt: 1,
    } as InternalSessionEntry;
    await replaceSessionEntry(scope, entry);
    const controller = createReplyRestartRecoveryClaimController({
      ...scope,
      admissionRunId: "new-admission-run",
      lifecycleGeneration: undefined,
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
