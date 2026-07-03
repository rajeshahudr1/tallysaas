#!/usr/bin/env node
'use strict';
// Splits a pg_dump --schema-only into master.sql + tenant.sql for the
// per-license DB split. Categorizes every statement by its table, maps
// sequences via ALTER SEQUENCE OWNED BY, and DROPS cross-DB foreign keys.
const fs = require('fs');
const path = require('path');
const DIR = __dirname;
const sql = fs.readFileSync(path.join(DIR, 'full_schema.sql'), 'utf8')
  .replace(/\r\n/g, '\n')
  .replace(/^\s*--.*$/gm, '');   // strip pg_dump comment lines (they contain ';' + precede each stmt)

// ── table categorization ─────────────────────────────────────
const MASTER_ONLY = new Set(['agent_releases','app_releases','license_permissions','licenses','password_resets','sessions','subscriptions','system_settings','user_sessions']);
const DUP = new Set(['users','permissions']);            // in BOTH dbs (mirror + catalogue)
// everything else = tenant-only
const inMaster = (t) => MASTER_ONLY.has(t) || DUP.has(t);
const inTenant = (t) => !MASTER_ONLY.has(t) || DUP.has(t); // NOT master-only, OR duplicated

// ── split into statements (pg_dump ends each with ";\n") ──────
const stmts = sql.split(/;[ \t]*\n/).map(s => s.trim()).filter(Boolean).map(s => s.endsWith(';') ? s : s + ';');

// First pass: sequence -> owning table (from ALTER SEQUENCE ... OWNED BY public.<table>.<col>)
const seqTable = {};
for (const s of stmts) {
  const m = s.match(/ALTER SEQUENCE (?:public\.)?"?([\w]+)"?\s+OWNED BY (?:public\.)?"?([\w]+)"?\./i);
  if (m) seqTable[m[1]] = m[2];
}

// Determine the table a statement belongs to.
function tableOf(s) {
  let m;
  if ((m = s.match(/^CREATE TABLE (?:IF NOT EXISTS )?(?:public\.)?"?([\w]+)"?/i))) return m[1];
  if ((m = s.match(/^CREATE (?:UNIQUE )?INDEX .* ON (?:public\.)?"?([\w]+)"?/i))) return m[1];
  if ((m = s.match(/^ALTER TABLE (?:ONLY )?(?:public\.)?"?([\w]+)"?/i))) return m[1];
  if ((m = s.match(/^ALTER SEQUENCE (?:public\.)?"?([\w]+)"?/i))) return seqTable[m[1]] || null;
  if ((m = s.match(/^CREATE SEQUENCE (?:public\.)?"?([\w]+)"?/i))) return seqTable[m[1]] || m[1].replace(/_[\w]+_seq$/, '');
  return null; // SET / SELECT / comments → global (goes to both, harmless)
}

// Is this an FK constraint? Return referenced table if so.
function fkTarget(s) {
  const m = s.match(/ADD CONSTRAINT .* FOREIGN KEY .* REFERENCES (?:public\.)?"?([\w]+)"?/i);
  return m ? m[1] : null;
}

const SKIP_TABLES = new Set(['knex_migrations', 'knex_migrations_lock']);
const master = [], tenant = [];
const dropped = { master: [], tenant: [] };
for (const s of stmts) {
  // Skip pg_dump session preamble (SET .../SELECT set_config) — knex.raw needs
  // pure DDL, and knex manages its own knex_migrations table.
  if (/^(SET |SELECT pg_catalog)/i.test(s)) continue;
  const t = tableOf(s);
  if (t && SKIP_TABLES.has(t)) continue;
  const isGlobal = false;
  const fkTo = fkTarget(s);

  // MASTER output
  if (t === null ? isGlobal : inMaster(t)) {
    if (fkTo && !inMaster(fkTo)) dropped.master.push(`${t}->${fkTo}`);
    else master.push(s);
  }
  // TENANT output
  if (t === null ? isGlobal : inTenant(t)) {
    if (fkTo && !inTenant(fkTo)) dropped.tenant.push(`${t}->${fkTo}`);
    else tenant.push(s);
  }
}

fs.writeFileSync(path.join(DIR, 'master.sql'), master.join('\n\n') + '\n');
fs.writeFileSync(path.join(DIR, 'tenant.sql'), tenant.join('\n\n') + '\n');
console.log('master.sql statements:', master.length, '| CREATE TABLE:', master.filter(s=>/^CREATE TABLE/i.test(s)).length);
console.log('tenant.sql statements:', tenant.length, '| CREATE TABLE:', tenant.filter(s=>/^CREATE TABLE/i.test(s)).length);
console.log('dropped cross-DB FKs (master):', dropped.master.join(', ') || 'none');
console.log('dropped cross-DB FKs (tenant):', dropped.tenant.join(', ') || 'none');
