// Contamination guard for direct cron deliveries.
//
// A scheduled cron run's final output is delivered verbatim to a chat. When a
// model completion comes back contaminated (provider-side context bleed can
// serve fragments of an unrelated conversation), the "message" can be raw
// tool-transcript JSON — including third-party private data — and it will be
// shipped to the recipient without a human in the loop. SON-5998: a founder
// compose job delivered 21.6k chars of an unrelated n8n research transcript.
//
// This guard inspects the final delivery text right before the channel send.
// It is signature-based and deliberately high-precision: raw tool-transcript
// JSON and mid-document JSON starts are essentially never legitimate chat
// messages, while an oversized direct chat delivery is held only past a very
// generous ceiling. Held deliveries are NOT sent; the owning agent's main
// session receives an awareness alert and the failure is logged for ops.
// The held output text is never echoed into logs or alerts so contaminated
// payload (which may carry third-party PII) does not propagate.

export type DeliveryOutputGuardVerdict = {
  hold: boolean;
  reasons: string[];
};

type SignatureRule = {
  id: string;
  label: string;
  test: (text: string) => boolean;
};

const SIGNATURE_RULES: SignatureRule[] = [
  {
    id: "anthropic_tool_use_id",
    label: "Anthropic-style tool-call id fragment (toolu_*)",
    test: (text) => /(^|[^\w])toolu_[\w]+/.test(text),
  },
  {
    id: "tool_result_json",
    label: 'raw tool transcript JSON ("type":"tool_result")',
    test: (text) => /"type"\s*:\s*"tool_(?:result|use)"/.test(text),
  },
  {
    id: "chat_roles_json",
    label: 'raw chat transcript JSON ("role":"assistant"/"user"/"tool")',
    test: (text) => /"role"\s*:\s*"(?:assistant|user|tool)"/.test(text),
  },
  {
    id: "events_array_fragment",
    label: "mid-document transcript fragment (leading events: [{)",
    test: (text) => /(?:^|\n)\s*events\s*:\s*\[\s*\{/.test(text),
  },
  {
    id: "leading_json_fragment",
    label: "output begins mid-JSON (starts with a document tail)",
    test: (text) => {
      const trimmed = text.trimStart();
      // A user-facing message never legitimately opens with a JSON document
      // tail such as `"]:`, `},` or `}]`.
      return /^[}\]]\s*[:,\]]?/.test(trimmed) || /^"\]\s*:/.test(trimmed);
    },
  },
];

const DEFAULT_MAX_CHARS = 12_000;
const MAX_CHARS_ENV = "OPENCLAW_CRON_DELIVERY_GUARD_MAX_CHARS";

export function resolveDeliveryOutputGuardMaxChars(cfg?: unknown): number {
  const fromConfig = readConfiguredMaxChars(cfg);
  if (fromConfig !== undefined) {
    return fromConfig;
  }
  const raw = process.env[MAX_CHARS_ENV];
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return DEFAULT_MAX_CHARS;
}

function readConfiguredMaxChars(cfg: unknown): number | undefined {
  // Optional config knob: cron.deliveryOutputGuardMaxChars. Kept out of the
  // typed schema in v1; unknown fields are preserved by the config loader.
  if (!cfg || typeof cfg !== "object") {
    return undefined;
  }
  const value = (cfg as Record<string, unknown>)["cron"];
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const maxChars = (value as Record<string, unknown>)["deliveryOutputGuardMaxChars"];
  if (typeof maxChars === "number" && Number.isFinite(maxChars) && maxChars >= 0) {
    return maxChars;
  }
  return undefined;
}

/**
 * Inspect final direct-cron delivery text for contamination signatures.
 * Returns every matching reason; `hold` is true when any signature matches or
 * the text exceeds the oversize ceiling (0 disables the ceiling).
 */
export function inspectDeliveryOutputGuard(
  text: string,
  opts?: { maxChars?: number },
): DeliveryOutputGuardVerdict {
  const reasons: string[] = [];
  if (typeof text === "string" && text.trim() !== "") {
    for (const rule of SIGNATURE_RULES) {
      if (rule.test(text)) {
        reasons.push(rule.label);
      }
    }
    const maxChars = opts?.maxChars ?? DEFAULT_MAX_CHARS;
    if (maxChars > 0 && text.length > maxChars) {
      reasons.push(`oversized direct delivery (${text.length} chars > ${maxChars} ceiling)`);
    }
  }
  return { hold: reasons.length > 0, reasons };
}

export function formatDeliveryOutputGuardHoldText(params: {
  jobId: string;
  channel: string;
  to?: string | number | null;
  threadId?: string | number | null;
  reasons: string[];
  inspectionUrl?: string;
}): string {
  const to = params.to == null ? undefined : String(params.to);
  const threadId = params.threadId == null ? undefined : String(params.threadId);
  const target = [params.channel, to, threadId != null ? `thread ${threadId}` : undefined]
    .filter((part) => part != null && part !== "")
    .join(" ");
  const inspection = params.inspectionUrl ? ` Inspect: ${params.inspectionUrl}` : "";
  return (
    `[cron:${params.jobId}] Direct delivery to ${target} was held by the delivery output guard: ` +
    `${params.reasons.join("; ")}. The scheduled output did not look like a safe message ` +
    `(raw tool-transcript/JSON fragments or gross oversize), so nothing was sent. ` +
    `Re-run or correct the job; the held text is retained in the run transcript only.${inspection}`
  );
}
