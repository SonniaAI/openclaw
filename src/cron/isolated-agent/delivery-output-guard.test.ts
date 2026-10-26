import { describe, expect, it } from "vitest";
import {
  formatDeliveryOutputGuardHoldText,
  inspectDeliveryOutputGuard,
  resolveDeliveryOutputGuardMaxChars,
} from "./delivery-output-guard.js";

describe("delivery output guard signatures", () => {
  it("passes a clean short scheduled message", () => {
    const verdict = inspectDeliveryOutputGuard(
      "Arthur, Szonja — the Telnyx calling account still needs a funding yes to finish acceptance items 8-11. Recommend approving; work continues meanwhile.",
    );
    expect(verdict.hold).toBe(false);
    expect(verdict.reasons).toEqual([]);
  });

  it("holds the SON-5998 incident shape (mid-JSON tool transcript)", () => {
    const contaminated = [
      '"]:',
      "events: [{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_vrtx_01\",\"content\":\"Found the paperclip skill. Key scripts:",
      '* `skills/paperclip/SKILL.md`',
      "Deep Research Agent (n8n) transcript follows",
    ].join("\n");
    const verdict = inspectDeliveryOutputGuard(contaminated);
    expect(verdict.hold).toBe(true);
    expect(verdict.reasons).toEqual([
      "Anthropic-style tool-call id fragment (toolu_*)",
      'raw tool transcript JSON ("type":"tool_result")',
      "mid-document transcript fragment (leading events: [{)",
      "output begins mid-JSON (starts with a document tail)",
    ]);
  });

  it("holds each contamination signature individually", () => {
    const cases: Array<[string, string]> = [
      ['call id toolu_vrtx_01 in prose', "Anthropic-style tool-call id fragment (toolu_*)"],
      ['{"type":"tool_use"} fragment', 'raw tool transcript JSON ("type":"tool_result")'],
      ['{"role":"assistant"} fragment', 'raw chat transcript JSON ("role":"assistant"/"user"/"tool")'],
      ["}], tail", "output begins mid-JSON (starts with a document tail)"],
      ["\"]: tail", "output begins mid-JSON (starts with a document tail)"],
    ];
    for (const [text, expected] of cases) {
      const verdict = inspectDeliveryOutputGuard(text);
      expect(verdict.hold, text).toBe(true);
      expect(verdict.reasons, text).toContain(expected);
    }
  });

  it("holds verbatim signature fragments even embedded in prose (known tradeoff)", () => {
    const verdict = inspectDeliveryOutputGuard(
      'Our tool results now include a type field; the docs show an example like "type": "tool_result" spelled out in prose.',
    );
    // Documented tradeoff: the guard is deliberately conservative about raw
    // transcript fragments in scheduled output; scheduled jobs should not
    // quote them verbatim in chat-bound messages.
    expect(verdict.hold).toBe(true);
  });

  it("holds oversize direct deliveries past the ceiling", () => {
    const verdict = inspectDeliveryOutputGuard("a".repeat(12_001));
    expect(verdict.hold).toBe(true);
    expect(verdict.reasons[0]).toContain("oversized");
    expect(inspectDeliveryOutputGuard("a".repeat(12_000)).hold).toBe(false);
  });

  it("honors a custom ceiling and disables it at 0", () => {
    expect(inspectDeliveryOutputGuard("a".repeat(301), { maxChars: 300 }).hold).toBe(true);
    expect(inspectDeliveryOutputGuard("a".repeat(300_001), { maxChars: 0 }).hold).toBe(false);
  });
});

describe("delivery output guard configuration", () => {
  const envKey = "OPENCLAW_CRON_DELIVERY_GUARD_MAX_CHARS";
  const original = process.env[envKey];

  it("defaults to 12000 chars", () => {
    delete process.env[envKey];
    expect(resolveDeliveryOutputGuardMaxChars(undefined)).toBe(12_000);
    expect(resolveDeliveryOutputGuardMaxChars({})).toBe(12_000);
  });

  it("reads the env override and falls back on garbage", () => {
    process.env[envKey] = "5000";
    expect(resolveDeliveryOutputGuardMaxChars(undefined)).toBe(5_000);
    process.env[envKey] = "not-a-number";
    expect(resolveDeliveryOutputGuardMaxChars(undefined)).toBe(12_000);
    process.env[envKey] = "-3";
    expect(resolveDeliveryOutputGuardMaxChars(undefined)).toBe(12_000);
  });

  it("prefers config over env and allows disabling via 0", () => {
    process.env[envKey] = "5000";
    expect(resolveDeliveryOutputGuardMaxChars({ cron: { deliveryOutputGuardMaxChars: 8000 } })).toBe(8_000);
    expect(resolveDeliveryOutputGuardMaxChars({ cron: { deliveryOutputGuardMaxChars: 0 } })).toBe(0);
    delete process.env[envKey];
  });

  it("restores env", () => {
    if (original === undefined) {
      delete process.env[envKey];
    } else {
      process.env[envKey] = original;
    }
    expect(true).toBe(true);
  });
});

describe("hold alert text", () => {
  it("names the job, target and reasons without echoing output", () => {
    const canaryOutput = "PRIVATE-CONTAMINATED-PAYLOAD-CANARY";
    const text = formatDeliveryOutputGuardHoldText({
      jobId: "53f70c84-3d99-4ff5-bfb2-c758ea940b81",
      channel: "telegram",
      to: "-1003889975049",
      threadId: "18025",
      reasons: ["Anthropic-style tool-call id fragment (toolu_*)"],
      inspectionUrl: "https://manager.example/inspect/run-1",
    });
    expect(text).toContain("53f70c84");
    expect(text).toContain("telegram");
    expect(text).toContain("held");
    expect(text).toContain("Inspect: https://manager.example/inspect/run-1");
    expect(text).not.toContain(canaryOutput);
  });
});
