import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import {
  createReplyRestartRecoveryClaimController,
  hasLiveRestartRecoveryClaimOwner,
} from "./restart-recovery-claim.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function staleOrphanEntry(sessionId: string): InternalSessionEntry {
  return {
    sessionId,
    updatedAt: 1,
    status: "running",
    activeWriterRunId: "dead-writer-run",
    lifecycleRunId: "dead-writer-run",
    restartRecoveryDeliveryRunId: "dead-claim-run",
    restartRecoveryDeliverySourceRunId: "dead-source-turn",
    startedAt: 1,
  } as InternalSessionEntry;
}

describe("SON-6091 restart-recovery claim orphan supersede", () => {
  it("treats an armed claim as orphaned when every owning run is dead", () => {
    const entry = staleOrphanEntry("ses");
    expect(hasLiveRestartRecoveryClaimOwner(entry, "dead-claim-run", () => false)).toBe(false);
  });

  it("keeps the refusal when the writer run is still live", () => {
    const entry = staleOrphanEntry("ses");
    expect(
      hasLiveRestartRecoveryClaimOwner(entry, "dead-claim-run", (runId) => runId === "dead-writer-run"),
    ).toBe(true);
  });

  it("keeps the refusal when the armed claim itself is still live", () => {
    const entry = staleOrphanEntry("ses");
    expect(
      hasLiveRestartRecoveryClaimOwner(entry, "dead-claim-run", (runId) => runId === "dead-claim-run"),
    ).toBe(true);
  });

  it("treats recovery-fence runs as owners too", () => {
    const entry = {
      ...staleOrphanEntry("ses"),
      restartRecoveryRuns: [{ runId: "fence-run", lifecycleGeneration: "gen-a" }],
    } as InternalSessionEntry;
    expect(hasLiveRestartRecoveryClaimOwner(entry, "dead-claim-run", (runId) => runId === "fence-run")).toBe(true);
    expect(hasLiveRestartRecoveryClaimOwner(entry, "dead-claim-run", () => false)).toBe(false);
  });
});
