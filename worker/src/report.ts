import type { D1Database } from "@cloudflare/workers-types";
import { analyzeNetwork } from "./ai";
import { buildDailySummary } from "./summary";
import { formatNoAiReport, formatTelegramReport, sendTelegram } from "./telegram";
import type { AiReport, DailySummary, Env } from "./types";
import { isoNow, previousDate } from "./time";

type ScanRow = { id: string; reason: string; status: string; subnet: string; started_at: string; completed_at: string };
type ObservationRow = { scan_id: string; ip: string; online: number; latencyMs?: number | null; hostname?: string | null; reason: string; scan_status: string; completed_at: string };

async function summaryForDate(db: D1Database, date: string, env: Env): Promise<DailySummary> {
  const scansResult = await db.prepare("SELECT id, reason, status, subnet, started_at, completed_at FROM scans WHERE local_date = ? ORDER BY completed_at").bind(date).all<ScanRow>();
  const scans = scansResult.results ?? [];
  const observationsResult = await db.prepare(`
    SELECT sd.scan_id, sd.ip, sd.online, sd.latency_ms AS latencyMs,
      COALESCE(sd.hostname, labels.hostname) AS hostname,
      s.reason, s.status AS scan_status, s.completed_at
    FROM scan_devices sd
    JOIN scans s ON s.id = sd.scan_id
    LEFT JOIN ip_hostnames labels ON labels.ip = sd.ip
    WHERE s.local_date = ? AND sd.online = 1
    ORDER BY s.completed_at, sd.ip
  `).bind(date).all<ObservationRow>();
  const previousRows = await db.prepare("SELECT DISTINCT sd.ip FROM scan_devices sd JOIN scans s ON s.id = sd.scan_id WHERE s.local_date = ? AND sd.online = 1").bind(previousDate(date)).all<{ ip: string }>();
  const knownRows = await db.prepare("SELECT id, trusted, label FROM devices").all<{ id: string; trusted: number; label: string | null }>();
  const known = new Map(knownRows.results.map((row) => [row.id, { trusted: row.trusted, label: row.label }]));
  const monitor = await db.prepare("SELECT last_seen_at, state, ip FROM devices WHERE id=?").bind(env.DEVICE_ID || "esp32-monitor-01").first<{ last_seen_at: string | null; state: string | null; ip: string | null }>();
  return buildDailySummary(date, scans, observationsResult.results.map((row) => ({ ...row, online: Boolean(row.online) })), new Set(previousRows.results.map((row) => row.ip)), known, monitor ? { lastSeenAt: monitor.last_seen_at ?? undefined, state: monitor.state ?? undefined, ip: monitor.ip ?? undefined } : undefined);
}

function reportId(): string {
  return crypto.randomUUID();
}

async function claimAutomaticReport(db: D1Database, date: string): Promise<boolean> {
  const now = isoNow();
  const existing = await db.prepare("SELECT report_date FROM daily_reports WHERE report_date=? AND status='sent'").bind(date).first<{ report_date: string }>();
  if (existing) return false;
  const inserted = await db.prepare("INSERT OR IGNORE INTO daily_report_deliveries(report_date, status, claimed_at, updated_at) VALUES (?, 'sending', ?, ?)").bind(date, now, now).run();
  if ((inserted.meta.changes ?? 0) === 1) return true;

  const current = await db.prepare("SELECT status, claimed_at FROM daily_report_deliveries WHERE report_date=?").bind(date).first<{ status: string; claimed_at: string }>();
  if (!current || current.status === "sent") return false;
  const stale = current.status === "failed" || Date.now() - Date.parse(current.claimed_at) > 10 * 60 * 1000;
  if (!stale) return false;
  const reclaimed = await db.prepare("UPDATE daily_report_deliveries SET status='sending', claimed_at=?, updated_at=? WHERE report_date=? AND status=? AND claimed_at=?").bind(now, now, date, current.status, current.claimed_at).run();
  return (reclaimed.meta.changes ?? 0) === 1;
}

async function markAutomaticReportFailed(db: D1Database, date: string): Promise<void> {
  await db.prepare("UPDATE daily_report_deliveries SET status='failed', updated_at=? WHERE report_date=? AND status='sending'").bind(isoNow(), date).run();
}

function deterministicFallback(summary: DailySummary): AiReport {
  const online = summary.devices.filter((device) => device.onlineCount > 0);
  const unstable = summary.devices.filter((device) => device.uptimePercent != null && device.uptimePercent < 80 && device.onlineCount > 0);
  const health = summary.failedScans > 0 || summary.incomplete ? "degraded" : unstable.length > Math.max(3, online.length / 2) ? "degraded" : "stable";
  const analysis = summary.totalScans <= 1
    ? "AI analysis was not run because there were fewer than two scans."
    : `AI analysis was unavailable, so this is a deterministic summary. ${online.length} IPs responded at least once; ${unstable.length} online IPs were intermittent. Offline addresses were excluded because they do not represent occupied devices.`;
  const recommendations: string[] = [];
  if (summary.newDevices.length > 0) recommendations.push(`Verify new online IPs: ${summary.newDevices.slice(0, 8).join(", ")}.`);
  if (unstable.length > 0) recommendations.push(`Check intermittent online devices: ${unstable.slice(0, 8).map((device) => device.ip).join(", ")}.`);
  if (summary.incomplete) recommendations.push("Review the ESP32 connection and repeat the scan because the day is incomplete.");
  if (recommendations.length === 0) recommendations.push("Continue hourly monitoring; no action is indicated by the available online-device data.");
  return { health, analysis, recommendations };
}

export async function generateReport(db: D1Database, env: Env, date: string, automatic: boolean): Promise<{ sent: boolean; reportId: string; message: string; scanCount: number | null; analysisPerformed: boolean; reason?: string }> {
  if (automatic && !(await claimAutomaticReport(db, date))) return { sent: false, reportId: date, message: "Automatic report already sent or in progress", scanCount: null, analysisPerformed: false, reason: "already_sent_or_in_progress" };

  try {
    const summary = await summaryForDate(db, date, env);
    let report: AiReport;
    let model = "none";
    if (summary.totalScans > 1) {
      try {
        report = await analyzeNetwork(summary, env);
        model = env.OPENROUTER_MODEL;
      } catch (error) {
        console.error("AI report failed; using deterministic fallback", error);
        report = deterministicFallback(summary);
        model = "deterministic-fallback";
      }
    } else {
      report = {
        health: "unknown" as const,
        analysis: "AI analysis was not run because there were fewer than two scans.",
        recommendations: [],
      };
    }
    const message = summary.totalScans > 1 ? formatTelegramReport(summary, report) : formatNoAiReport(summary);
    await sendTelegram(message, env);
    const now = isoNow();
    if (automatic) {
      await db.batch([
        db.prepare(`
          INSERT INTO daily_reports(report_date, summary_json, report_json, message, model, status, sent_at)
          VALUES (?, ?, ?, ?, ?, 'sent', ?)
          ON CONFLICT(report_date) DO UPDATE SET summary_json=excluded.summary_json, report_json=excluded.report_json, message=excluded.message, model=excluded.model, status='sent', sent_at=excluded.sent_at
        `).bind(date, JSON.stringify(summary), JSON.stringify(report), message, model, now),
        db.prepare("UPDATE daily_report_deliveries SET status='sent', sent_at=?, updated_at=? WHERE report_date=? AND status='sending'").bind(now, now, date),
      ]);
      return { sent: true, reportId: date, message, scanCount: summary.totalScans, analysisPerformed: summary.totalScans > 1, ...(summary.totalScans === 0 ? { reason: "no_scans" } : summary.totalScans === 1 ? { reason: "insufficient_scans" } : {}) };
    }

    const id = reportId();
    await db.prepare("INSERT INTO manual_report_runs(id, report_date, summary_json, report_json, message, model, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, date, JSON.stringify(summary), JSON.stringify(report), message, model, now).run();
    return { sent: true, reportId: id, message, scanCount: summary.totalScans, analysisPerformed: summary.totalScans > 1, ...(summary.totalScans === 0 ? { reason: "no_scans" } : summary.totalScans === 1 ? { reason: "insufficient_scans" } : {}) };
  } catch (error) {
    if (automatic) await markAutomaticReportFailed(db, date);
    throw error;
  }
}
