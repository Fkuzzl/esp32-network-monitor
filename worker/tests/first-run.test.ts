import { describe, expect, it } from "vitest";
import { formatNoAiReport } from "../src/telegram";
import type { DailySummary } from "../src/types";

describe("first-run report messaging", () => {
  it("explains an empty database without invoking AI", () => {
    const message = formatNoAiReport({ date: "2026-08-23", totalScans: 0 } as unknown as DailySummary);
    expect(message).toContain("No AI report today.");
    expect(message).toContain("no scans were uploaded");
    expect(message).toContain("power on the ESP32");
  });

  it("explains why one scan is insufficient", () => {
    const message = formatNoAiReport({ date: "2026-08-23", totalScans: 1 } as unknown as DailySummary);
    expect(message).toContain("only 1 scan was uploaded");
    expect(message).toContain("at least 2 scans are required");
  });
});
