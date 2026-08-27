import type { DailySummary, DeviceSummary, MonitorSummary, ScanDevice } from "./types";

type ScanRow = {
  id: string;
  reason: string;
  status: string;
  subnet: string;
  started_at: string;
  completed_at: string;
};

type ObservationRow = ScanDevice & {
  scan_id: string;
  reason: string;
  scan_status: string;
  completed_at: string;
};

type KnownDevice = { trusted: number; label: string | null };

function average(values: number[]): number | undefined {
  return values.length === 0 ? undefined : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function compareIps(left: string, right: string): number {
  return left.split(".").reduce((value, part) => value * 256 + Number(part), 0) - right.split(".").reduce((value, part) => value * 256 + Number(part), 0);
}

export function buildDailySummary(
  date: string,
  scans: ScanRow[],
  observations: ObservationRow[],
  previousIps: Set<string>,
  knownDevices: Map<string, KnownDevice>,
  monitor?: Omit<MonitorSummary, "scheduledGapCount" | "longestScheduledGapMinutes" | "latestScheduledScanAt">,
): DailySummary {
  const grouped = new Map<string, ObservationRow[]>();
  for (const observation of observations) {
    const rows = grouped.get(observation.ip) ?? [];
    rows.push(observation);
    grouped.set(observation.ip, rows);
  }

  const completedScanRows = scans.filter((scan) => scan.status === "completed");
  const devices: DeviceSummary[] = [...grouped.entries()]
    // New firmware persists only responsive observations. Historical full
    // scans remain compatible because report queries select online rows.
    .filter(([, rows]) => rows.some((row) => row.online))
    .map(([ip, rows]) => {
    const online = rows.filter((row) => row.online && completedScanRows.some((scan) => scan.id === row.scan_id));
    const latency = online.flatMap((row) => row.latencyMs == null ? [] : [Number(row.latencyMs)]);
    const onlineScanIds = new Set(online.map((row) => row.scan_id));
    let transitions = 0;
    for (let index = 1; index < completedScanRows.length; index += 1) {
      if (onlineScanIds.has(completedScanRows[index].id) !== onlineScanIds.has(completedScanRows[index - 1].id)) transitions += 1;
    }
    const hostnames = rows.map((row) => row.hostname).filter((value): value is string => Boolean(value));
    const known = knownDevices.get(ip);
    return {
      ip,
      hostname: hostnames.at(-1),
      onlineCount: online.length,
      sampleCount: completedScanRows.length,
      uptimePercent: completedScanRows.length > 0 ? Math.round((online.length / completedScanRows.length) * 100) : undefined,
      firstSeen: rows[0].completed_at,
      lastSeen: rows.at(-1)?.completed_at ?? rows[0].completed_at,
      averageLatencyMs: average(latency),
      maxLatencyMs: latency.length === 0 ? undefined : Math.max(...latency),
      transitions,
      trusted: known?.trusted === 1,
      label: known?.label ?? undefined,
    };
    }).sort((a, b) => compareIps(a.ip, b.ip));

  const currentIps = new Set(devices.map((device) => device.ip));
  const newDevices = [...currentIps].filter((ip) => !previousIps.has(ip)).sort(compareIps);
  const missingDevices = [...previousIps].filter((ip) => !currentIps.has(ip)).sort(compareIps);
  const unstableDevices = devices.filter((device) => (device.uptimePercent != null && device.uptimePercent < 80) || device.transitions >= 4).map((device) => device.ip).sort(compareIps);
  const scheduled = scans.filter((scan) => scan.reason === "hourly");
  let scheduledGapCount = 0;
  let longestScheduledGapMinutes: number | undefined;
  for (let index = 1; index < scheduled.length; index += 1) {
    const gapMinutes = Math.round((Date.parse(scheduled[index].completed_at) - Date.parse(scheduled[index - 1].completed_at)) / 60000);
    if (gapMinutes > 90) {
      scheduledGapCount += 1;
      longestScheduledGapMinutes = Math.max(longestScheduledGapMinutes ?? 0, gapMinutes);
    }
  }
  const manualScans = scans.filter((scan) => scan.reason === "manual").length;
  const scheduledScans = scans.filter((scan) => scan.reason === "hourly").length;
  return {
    date,
    subnet: scans[0]?.subnet ?? "unknown private IPv4 subnet",
    totalScans: scans.length,
    scheduledScans,
    manualScans,
    startupScans: scans.filter((scan) => scan.reason === "startup").length,
    failedScans: scans.filter((scan) => scan.status === "failed").length,
    completedScans: completedScanRows.length,
    incomplete: scans.length === 0 || scans.some((scan) => scan.status !== "completed"),
    firstScanAt: scans[0]?.started_at,
    lastScanAt: scans.at(-1)?.completed_at,
    devicesObserved: devices.length,
    newDevices,
    missingDevices,
    unstableDevices,
    devices,
    monitor: {
      ...monitor,
      scheduledGapCount,
      longestScheduledGapMinutes,
      latestScheduledScanAt: scheduled.at(-1)?.completed_at,
    },
  };
}
