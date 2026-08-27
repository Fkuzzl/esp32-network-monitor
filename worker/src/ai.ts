import type { AiReport, DailySummary, Env } from "./types";

export class OpenRouterError extends Error {
  constructor(public readonly providerStatus: number, message: string) {
    super(message);
    this.name = "OpenRouterError";
  }
}

function extractMessageContent(message: { content?: unknown; reasoning?: unknown; reasoning_content?: unknown }): string | undefined {
  if (typeof message.content === "string" && message.content.trim()) return message.content;
  if (Array.isArray(message.content)) {
    const text = message.content
      .map((part) => typeof part === "string" ? part : part && typeof part === "object" && "text" in part ? (part as { text?: unknown }).text : undefined)
      .filter((part): part is string => typeof part === "string")
      .join("")
      .trim();
    if (text) return text;
  }
  // Some DeepSeek-compatible routes expose the generated answer under
  // reasoning_content instead of message.content.
  if (typeof message.reasoning_content === "string" && message.reasoning_content.trim()) return message.reasoning_content;
  return undefined;
}

function parseJsonObject(text: string): AiReport {
  try {
    return JSON.parse(text) as AiReport;
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("OpenRouter returned non-JSON content");
    return JSON.parse(text.slice(start, end + 1)) as AiReport;
  }
}

const schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    health: { type: "string", enum: ["stable", "degraded", "critical", "unknown"] },
    analysis: { type: "string" },
    recommendations: { type: "array", items: { type: "string" }, maxItems: 3 },
  },
  required: ["health", "analysis", "recommendations"],
};

export async function analyzeNetwork(summary: DailySummary, env: Env): Promise<AiReport> {
  // Send only aggregate defensive telemetry to the model. Raw IP observations
  // remain in D1 and can still be included deterministically in Telegram.
  const modelInput = {
    date: summary.date,
    networkType: "private home network availability summary",
    totalScans: summary.totalScans,
    scheduledScans: summary.scheduledScans,
    manualScans: summary.manualScans,
    startupScans: summary.startupScans,
    failedScans: summary.failedScans,
    completedScans: summary.completedScans,
    incomplete: summary.incomplete,
    devicesObserved: summary.devicesObserved,
    newDeviceCount: summary.newDevices.length,
    missingDeviceCount: summary.missingDevices.length,
    unstableDeviceCount: summary.unstableDevices.length,
    monitor: summary.monitor,
    // Only online-observed devices are sent to AI. Offline probe targets are
    // empty addresses, not high-latency devices.
    onlineDevices: summary.devices.map((device) => ({
      ip: device.ip,
      uptimePercent: device.uptimePercent,
      averageLatencyMs: device.averageLatencyMs,
      maxLatencyMs: device.maxLatencyMs,
      transitions: device.transitions,
      trusted: device.trusted,
      hasLabel: Boolean(device.label),
    })),
  };

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "content-type": "application/json",
      "http-referer": "https://workers.dev/",
      "x-title": "ESP32 Network Monitor",
    },
    body: JSON.stringify({
      model: env.OPENROUTER_MODEL,
      temperature: 0.1,
      // Ox Alpha requires reasoning. Keep it low for this deterministic
      // network summary and exclude internal reasoning from the report.
      max_tokens: 1200,
      reasoning: { effort: "low", exclude: true },
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "Analyze only the supplied private home-network availability summary and onlineDevices. Focus only on IPs that answered at least one ping. Offline probe targets are unoccupied addresses and must not be described as high latency, unstable, or failed devices. Write a concise analysis of at most 2 sentences, using evidence and uncertainty. Mention that latency is measured only during successful pings when relevant. Do not infer identity, intent, or wrongdoing. Return only one JSON object with exactly these keys: health (stable, degraded, critical, or unknown), analysis (string), recommendations (array of strings, maximum 2). Each recommendation must be one short actionable sentence.",
        },
        { role: "user", content: JSON.stringify(modelInput) },
      ],
    }),
  });
  if (!response.ok) throw new OpenRouterError(response.status, `OpenRouter failed: ${response.status} ${await response.text()}`);
  const body = await response.json() as {
    choices?: Array<{
      finish_reason?: string;
      message?: { content?: unknown; reasoning?: unknown; reasoning_content?: unknown };
    }>;
  };
  const message = body.choices?.[0]?.message;
  const text = message ? extractMessageContent(message) : undefined;
  if (!text) {
    const finishReason = body.choices?.[0]?.finish_reason ?? "unknown";
    const messageKeys = message ? Object.keys(message).join(",") : "none";
    throw new Error(`OpenRouter returned no visible content (finish_reason=${finishReason}, message_keys=${messageKeys})`);
  }
  const result = parseJsonObject(text);
  if (!schema.properties.health.enum.includes(result.health) || typeof result.analysis !== "string" || !Array.isArray(result.recommendations)) {
    throw new Error("OpenRouter returned invalid report JSON");
  }
  return result;
}
