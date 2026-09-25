// SQLite persistence for the Agent. Plain functions over SqlStorage so the schema and the
// queries are in one place. JSON columns hold values that are only ever read back whole.

import type { Diagnostic, Incident, IncidentStatus, ReplayResult, RuleAST, RuleVersion } from "../core/types";
import type { StepStatus, StepView } from "./views";

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS traffic_chunks (
     scenario_id TEXT NOT NULL,
     seed INTEGER NOT NULL,
     chunk_index INTEGER NOT NULL,
     start INTEGER NOT NULL,
     count INTEGER NOT NULL,
     blob BLOB NOT NULL,
     digest TEXT NOT NULL,
     partial TEXT NOT NULL,
     PRIMARY KEY (scenario_id, seed, chunk_index)
   )`,
  `CREATE TABLE IF NOT EXISTS incidents (
     id TEXT PRIMARY KEY,
     status TEXT NOT NULL,
     proposed_rule_version_id TEXT,
     applied_rule_version_id TEXT,
     data TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS rule_versions (
     id TEXT PRIMARY KEY,
     incident_id TEXT NOT NULL,
     source TEXT NOT NULL,
     attempt INTEGER NOT NULL,
     status TEXT NOT NULL,
     raw_model_output TEXT NOT NULL,
     ast TEXT,
     text TEXT,
     replay TEXT,
     diagnostics TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  // Append-only audit log. Written before the workflow is signaled; read by the apply step.
  `CREATE TABLE IF NOT EXISTS approvals (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     incident_id TEXT NOT NULL,
     rule_version_id TEXT,
     decision TEXT NOT NULL,
     reason TEXT,
     decided_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS steps (
     incident_id TEXT NOT NULL,
     name TEXT NOT NULL,
     status TEXT NOT NULL,
     detail TEXT,
     at INTEGER NOT NULL,
     PRIMARY KEY (incident_id, name)
   )`,
  // Blocked requests per time bucket and status class, for the traffic panel. Derived from the
  // same replay as the counts.
  `CREATE TABLE IF NOT EXISTS replay_panels (
     rule_version_id TEXT PRIMARY KEY,
     panel TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS summaries (
     incident_id TEXT PRIMARY KEY,
     data TEXT NOT NULL
   )`,
];

export function migrate(sql: SqlStorage): void {
  for (const stmt of SCHEMA) sql.exec(stmt);
}

// ---------------------------------------------------------------------------
// Traffic
// ---------------------------------------------------------------------------

export type ChunkRow = { chunkIndex: number; start: number; count: number; digest: string };

export function listChunks(sql: SqlStorage, scenarioId: string, seed: number): ChunkRow[] {
  return sql
    .exec<{ chunk_index: number; start: number; count: number; digest: string }>(
      "SELECT chunk_index, start, count, digest FROM traffic_chunks WHERE scenario_id = ? AND seed = ? ORDER BY chunk_index",
      scenarioId,
      seed,
    )
    .toArray()
    .map((r) => ({ chunkIndex: r.chunk_index, start: r.start, count: r.count, digest: r.digest }));
}

export function readChunkBlob(sql: SqlStorage, scenarioId: string, seed: number, chunkIndex: number): ArrayBuffer | null {
  const row = sql
    .exec<{ blob: ArrayBuffer }>(
      "SELECT blob FROM traffic_chunks WHERE scenario_id = ? AND seed = ? AND chunk_index = ?",
      scenarioId,
      seed,
      chunkIndex,
    )
    .toArray()[0];
  return row ? row.blob : null;
}

export function readPartials(sql: SqlStorage, scenarioId: string, seed: number): string[] {
  return sql
    .exec<{ partial: string }>(
      "SELECT partial FROM traffic_chunks WHERE scenario_id = ? AND seed = ? ORDER BY chunk_index",
      scenarioId,
      seed,
    )
    .toArray()
    .map((r) => r.partial);
}

export function insertChunk(
  sql: SqlStorage,
  row: ChunkRow & { scenarioId: string; seed: number; blob: Uint8Array; partial: string },
): void {
  // INSERT OR IGNORE: generation is deterministic, so a retried chunk call writes identical
  // bytes and the first write wins.
  sql.exec(
    "INSERT OR IGNORE INTO traffic_chunks (scenario_id, seed, chunk_index, start, count, blob, digest, partial) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    row.scenarioId,
    row.seed,
    row.chunkIndex,
    row.start,
    row.count,
    row.blob,
    row.digest,
    row.partial,
  );
}

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

export function saveIncident(sql: SqlStorage, incident: Incident): void {
  sql.exec(
    `INSERT INTO incidents (id, status, proposed_rule_version_id, applied_rule_version_id, data, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status,
       proposed_rule_version_id = excluded.proposed_rule_version_id,
       applied_rule_version_id = excluded.applied_rule_version_id,
       data = excluded.data`,
    incident.id,
    incident.status,
    incident.proposedRuleVersionId,
    incident.appliedRuleVersionId,
    JSON.stringify(incident),
    incident.createdAt,
  );
}

export function getIncident(sql: SqlStorage, id: string): Incident | null {
  const row = sql.exec<{ data: string }>("SELECT data FROM incidents WHERE id = ?", id).toArray()[0];
  return row ? (JSON.parse(row.data) as Incident) : null;
}

export function listIncidents(sql: SqlStorage, limit: number): Incident[] {
  return sql
    .exec<{ data: string }>("SELECT data FROM incidents ORDER BY created_at DESC, id DESC LIMIT ?", limit)
    .toArray()
    .map((r) => JSON.parse(r.data) as Incident);
}

export function countIncidentsWithStatus(sql: SqlStorage, statuses: readonly IncidentStatus[]): number {
  const placeholders = statuses.map(() => "?").join(", ");
  const row = sql
    .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM incidents WHERE status IN (${placeholders})`, ...statuses)
    .toArray()[0];
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Rule versions
// ---------------------------------------------------------------------------

type RuleVersionRow = {
  id: string;
  incident_id: string;
  source: string;
  attempt: number;
  status: string;
  raw_model_output: string;
  ast: string | null;
  text: string | null;
  replay: string | null;
  diagnostics: string;
  created_at: number;
};

export function saveRuleVersion(sql: SqlStorage, v: RuleVersion): void {
  sql.exec(
    `INSERT INTO rule_versions (id, incident_id, source, attempt, status, raw_model_output, ast, text, replay, diagnostics, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status, ast = excluded.ast, text = excluded.text,
       replay = excluded.replay, diagnostics = excluded.diagnostics`,
    v.id,
    v.incidentId,
    v.source,
    v.attempt,
    v.status,
    v.rawModelOutput,
    v.ast ? JSON.stringify(v.ast) : null,
    v.text,
    v.replay ? JSON.stringify(v.replay) : null,
    JSON.stringify(v.diagnostics),
    v.createdAt,
  );
}

export function getRuleVersion(sql: SqlStorage, id: string): RuleVersion | null {
  const r = sql.exec<RuleVersionRow>("SELECT * FROM rule_versions WHERE id = ?", id).toArray()[0];
  if (!r) return null;
  return {
    id: r.id,
    incidentId: r.incident_id,
    source: r.source === "naive-baseline" ? "naive-baseline" : "model",
    attempt: r.attempt,
    status: r.status as RuleVersion["status"],
    rawModelOutput: r.raw_model_output,
    ast: r.ast ? (JSON.parse(r.ast) as RuleAST) : null,
    text: r.text,
    replay: r.replay ? (JSON.parse(r.replay) as ReplayResult) : null,
    diagnostics: JSON.parse(r.diagnostics) as Diagnostic[],
    createdAt: r.created_at,
  };
}

// ---------------------------------------------------------------------------
// Approvals (append only)
// ---------------------------------------------------------------------------

export type ApprovalRow = {
  incidentId: string;
  ruleVersionId: string | null;
  decision: "approved" | "rejected";
  reason: string | null;
  decidedAt: number;
};

export function appendApproval(sql: SqlStorage, a: ApprovalRow): void {
  sql.exec(
    "INSERT INTO approvals (incident_id, rule_version_id, decision, reason, decided_at) VALUES (?, ?, ?, ?, ?)",
    a.incidentId,
    a.ruleVersionId,
    a.decision,
    a.reason,
    a.decidedAt,
  );
}

export function findApproval(sql: SqlStorage, incidentId: string, ruleVersionId: string): ApprovalRow | null {
  const r = sql
    .exec<{ decided_at: number; reason: string | null }>(
      "SELECT decided_at, reason FROM approvals WHERE incident_id = ? AND rule_version_id = ? AND decision = 'approved' ORDER BY seq DESC LIMIT 1",
      incidentId,
      ruleVersionId,
    )
    .toArray()[0];
  return r ? { incidentId, ruleVersionId, decision: "approved", reason: r.reason, decidedAt: r.decided_at } : null;
}

/** "Unsafe actions" from DESIGN.md section 9: applied rules with no matching approval row. */
export function countUnsafeActions(sql: SqlStorage): number {
  const row = sql
    .exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM incidents i
       WHERE i.applied_rule_version_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.incident_id = i.id
           AND a.rule_version_id = i.applied_rule_version_id AND a.decision = 'approved')`,
    )
    .toArray()[0];
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Steps and summaries
// ---------------------------------------------------------------------------

export function upsertStep(sql: SqlStorage, incidentId: string, name: string, status: StepStatus, detail: string | null, at: number) {
  sql.exec(
    `INSERT INTO steps (incident_id, name, status, detail, at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(incident_id, name) DO UPDATE SET status = excluded.status, detail = excluded.detail, at = excluded.at`,
    incidentId,
    name,
    status,
    detail,
    at,
  );
}

export function listSteps(sql: SqlStorage, incidentId: string): StepView[] {
  return sql
    .exec<{ name: string; status: StepStatus; detail: string | null; at: number }>(
      "SELECT name, status, detail, at FROM steps WHERE incident_id = ? ORDER BY rowid",
      incidentId,
    )
    .toArray()
    .map((r) => ({ name: r.name, status: r.status, detail: r.detail, at: r.at }));
}

export function saveSummary(sql: SqlStorage, incidentId: string, data: string): void {
  sql.exec("INSERT OR REPLACE INTO summaries (incident_id, data) VALUES (?, ?)", incidentId, data);
}

export function getSummary(sql: SqlStorage, incidentId: string): string | null {
  return sql.exec<{ data: string }>("SELECT data FROM summaries WHERE incident_id = ?", incidentId).toArray()[0]?.data ?? null;
}

export function savePanel(sql: SqlStorage, ruleVersionId: string, panel: number[][]): void {
  sql.exec("INSERT OR REPLACE INTO replay_panels (rule_version_id, panel) VALUES (?, ?)", ruleVersionId, JSON.stringify(panel));
}

export function getPanel(sql: SqlStorage, ruleVersionId: string | null): number[][] | null {
  if (!ruleVersionId) return null;
  const raw = sql.exec<{ panel: string }>("SELECT panel FROM replay_panels WHERE rule_version_id = ?", ruleVersionId).toArray()[0];
  return raw ? (JSON.parse(raw.panel) as number[][]) : null;
}
