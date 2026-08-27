import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

type CapturedStatement = {
  sql: string;
  bindings: unknown[];
  operation?: "first" | "run";
};

class FakeStatement {
  private bindings: unknown[] = [];

  constructor(
    private readonly sql: string,
    private readonly captured: CapturedStatement[],
  ) {}

  bind(...values: unknown[]): FakeStatement {
    this.bindings = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    this.captured.push({ sql: this.sql, bindings: this.bindings, operation: "first" });
    return null;
  }

  async run(): Promise<{ meta: { changes: number } }> {
    this.captured.push({ sql: this.sql, bindings: this.bindings, operation: "run" });
    return { meta: { changes: 1 } };
  }
}

function testEnv(captured: CapturedStatement[]): Env {
  const database = {
    prepare(sql: string) {
      return new FakeStatement(sql, captured);
    },
  };
  return {
    DB: database,
    REPORT_TIMEZONE: "Asia/Shanghai",
    OPENROUTER_MODEL: "test",
    MAX_COMMAND_AGE_SECONDS: "900",
    DATA_RETENTION_DAYS: "31",
    DEVICE_ID: "esp32-monitor-01",
    OPENROUTER_API_KEY: "test",
    TELEGRAM_BOT_TOKEN: "test",
    TELEGRAM_CHAT_ID: "1",
    ESP32_DEVICE_TOKEN: "device-token",
    ADMIN_API_KEY: "admin-key",
  } as unknown as Env;
}

describe("direct ESP32 health refresh", () => {
  it("queues an authenticated direct health request", async () => {
    const captured: CapturedStatement[] = [];
    const response = await worker.fetch(
      new Request("https://example.test/v1/status-requests", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-admin-key": "admin-key",
        },
        body: JSON.stringify({ deviceId: "esp32-monitor-01" }),
      }),
      testEnv(captured),
    );

    expect(response.status).toBe(202);
    const body = await response.json() as {
      commandId: string;
      status: string;
      duplicate: boolean;
      requestedAt: string;
    };
    expect(body.commandId).toMatch(/^cmd_/);
    expect(body.status).toBe("queued");
    expect(body.duplicate).toBe(false);
    expect(Date.parse(body.requestedAt)).not.toBeNaN();

    const insert = captured.find((statement) => statement.sql.includes("INSERT INTO commands"));
    expect(insert?.bindings[0]).toBe(body.commandId);
    expect(insert?.bindings[1]).toBe("esp32-monitor-01");
    expect(insert?.bindings[2]).toBe(JSON.stringify({ source: "direct_api" }));
  });

  it("persists a normal health update with one device write", async () => {
    const captured: CapturedStatement[] = [];
    const response = await worker.fetch(
      new Request("https://example.test/v1/status", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-device-token": "device-token",
        },
        body: JSON.stringify({
          deviceId: "esp32-monitor-01",
          state: "idle",
          ip: "192.168.1.20",
          rssi: -55,
          firmwareVersion: "0.4.0",
          capabilities: ["health_check"],
        }),
      }),
      testEnv(captured),
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { accepted: boolean; receivedAt: string };
    expect(body.accepted).toBe(true);
    expect(Date.parse(body.receivedAt)).not.toBeNaN();

    const writes = captured.filter((statement) => statement.operation === "run");
    expect(writes).toHaveLength(1);
    expect(writes[0].sql).toContain("INSERT INTO devices");
    expect(writes[0].sql).toContain("firmware_version");
    expect(writes[0].sql).toContain("capabilities_json");
  });
});
