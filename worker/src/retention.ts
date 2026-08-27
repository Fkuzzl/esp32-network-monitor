import type { D1Database } from "@cloudflare/workers-types";
import { isoNow } from "./time";

export async function cleanupOldData(db: D1Database, retentionDays: number): Promise<void> {
  const safeDays = Number.isFinite(retentionDays) && retentionDays > 0 ? Math.floor(retentionDays) : 31;
  const cutoff = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000);
  const cutoffIso = cutoff.toISOString();
  const cutoffDate = cutoffIso.slice(0, 10);

  // Delete child rows before parent scans. Device inventory/status and labels
  // are retained. Command expiry is done once per daily cleanup, not poll.
  await db.batch([
    db.prepare("UPDATE commands SET status='expired' WHERE status IN ('queued','claimed') AND expires_at < ?").bind(isoNow()),
    db.prepare("DELETE FROM scan_devices WHERE scan_id IN (SELECT id FROM scans WHERE completed_at < ?)").bind(cutoffIso),
    db.prepare("DELETE FROM scans WHERE completed_at < ?").bind(cutoffIso),
    db.prepare("DELETE FROM daily_reports WHERE report_date < ?").bind(cutoffDate),
    db.prepare("DELETE FROM daily_report_deliveries WHERE report_date < ?").bind(cutoffDate),
    db.prepare("DELETE FROM manual_report_runs WHERE sent_at < ?").bind(cutoffIso),
    db.prepare("DELETE FROM idempotency_keys WHERE created_at < ?").bind(cutoffIso),
    db.prepare("DELETE FROM commands WHERE created_at < ?").bind(cutoffIso),
  ]);
}
