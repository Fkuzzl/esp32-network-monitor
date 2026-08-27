import { describe, expect, it } from "vitest";
import { buildDailySummary } from "../src/summary";

describe("buildDailySummary", () => {
  it("includes extra manual scans instead of assuming 24", () => {
    const scans = Array.from({ length: 25 }, (_, index) => ({
      id: `scan-${index}`,
      reason: index === 24 ? "manual" : "hourly",
      status: "completed",
      subnet: "192.168.1.0/24",
      started_at: `2026-08-22T${String(index % 24).padStart(2, "0")}:00:00Z`,
      completed_at: `2026-08-22T${String(index % 24).padStart(2, "0")}:01:00Z`,
    }));
    const observations = scans.map((scan) => ({
      scan_id: scan.id,
      ip: "192.168.1.10",
      online: true,
      latencyMs: 10,
      hostname: "router",
      reason: scan.reason,
      scan_status: scan.status,
      completed_at: scan.completed_at,
    }));
    const summary = buildDailySummary("2026-08-22", scans, observations, new Set(), new Map());
    expect(summary.totalScans).toBe(25);
    expect(summary.scheduledScans).toBe(24);
    expect(summary.manualScans).toBe(1);
    expect(summary.devices[0].uptimePercent).toBe(100);
  });

  it("ignores offline probe targets when counting observed devices", () => {
    const scans = [
      {
        id: "scan-1",
        reason: "hourly",
        status: "completed",
        subnet: "192.168.1.0/24",
        started_at: "2026-08-22T10:00:00Z",
        completed_at: "2026-08-22T10:01:00Z",
      },
      {
        id: "scan-2",
        reason: "hourly",
        status: "completed",
        subnet: "192.168.1.0/24",
        started_at: "2026-08-22T11:00:00Z",
        completed_at: "2026-08-22T11:01:00Z",
      },
    ];
    const observations = scans.flatMap((scan) => [
      {
        scan_id: scan.id,
        ip: "192.168.1.10",
        online: true,
        latencyMs: 10,
        hostname: null,
        reason: scan.reason,
        scan_status: scan.status,
        completed_at: scan.completed_at,
      },
      {
        scan_id: scan.id,
        ip: "192.168.1.11",
        online: false,
        latencyMs: null,
        hostname: null,
        reason: scan.reason,
        scan_status: scan.status,
        completed_at: scan.completed_at,
      },
    ]);
    const summary = buildDailySummary("2026-08-22", scans, observations, new Set(), new Map());
    expect(summary.devicesObserved).toBe(1);
    expect(summary.devices.map((device) => device.ip)).toEqual(["192.168.1.10"]);
    expect(summary.unstableDevices).toEqual([]);
  });

  it("calculates sparse-observation uptime and transitions from completed scans", () => {
    const scans = ["10:00", "11:00"].map((time, index) => ({
      id: `scan-${index}`,
      reason: "hourly",
      status: "completed",
      subnet: "192.168.1.0/24",
      started_at: `2026-08-22T${time}:00Z`,
      completed_at: `2026-08-22T${time}:30Z`,
    }));
    const observations = [{
      scan_id: "scan-0",
      ip: "192.168.1.10",
      online: true,
      latencyMs: 10,
      hostname: null,
      reason: "hourly",
      scan_status: "completed",
      completed_at: scans[0].completed_at,
    }];
    const summary = buildDailySummary("2026-08-22", scans, observations, new Set(), new Map());
    expect(summary.devices[0].uptimePercent).toBe(50);
    expect(summary.devices[0].transitions).toBe(1);
    expect(summary.monitor?.scheduledGapCount).toBe(0);
  });
});
