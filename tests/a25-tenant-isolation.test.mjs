// a25 -- TENANT ISOLATION. Can one company read or change another company's data?
//
// Nearly everything proven before this was WITHIN a company (the crew boundary:
// what an OWNER, a MANAGER and a CREW login may do inside one business). The one
// earlier company-against-company probe was P4's, against the Realtime change feed
// (supabase_p4_realtime_probe.sql). This attacks the tables, the storage bucket,
// the SECURITY DEFINER functions and that change feed again, with one company
// holding the strongest login a tenant can have and the other holding the data.
//
// HOW. One rolled-back transaction against production (`supabase db query
// --linked`, the technique of tests/r6-price-crew.test.mjs). Inside it the probe
// builds a synthetic ATTACKER company (A), a synthetic VICTIM company (B) and a
// third, empty one (X), every id in the namespace a25xxxxx-0000-4000-8000-..., every
// name "PROBE-A25-...", every address @probe.invalid. Then `set local role
// authenticated` with a JWT for A's OWNER -- the strongest login a tenant can
// hold, so any refusal has to come from the company boundary and not from a role
// check -- and attempts, against B's rows:
//     SELECT   another company's rows (and, as a census, EVERY row that is not A's,
//              which takes in the real tenants without writing a byte to them)
//     UPDATE   them, and move one of A's own rows INTO B, and pull one of B's into A
//     DELETE   them
//     INSERT   a row carrying B's company_id (tenant poisoning), and the same row as
//              an upsert onto a key B already holds
//     REFERENCE B's job by its sync id from a row that carries A's own company id
//              (accepted by the policy, so the question is whether it reaches B)
// It repeats the reads as anon and as signed-in people who belong to no company,
// attacks the job-files bucket and the crew views the same way, subscribes to the
// change feed and asks the DEPLOYED realtime.apply_rls() whether B's changes reach A,
// then calls every SECURITY DEFINER function that takes a caller-supplied id with B's ids.
//
// THE PROBE HAS TEETH. A second run plants an allow-all policy on every tenant table
// and demands that the isolation checks go red; a probe that stays green with the
// wall knocked down was never measuring the wall. And the live run must fail on
// EXACTLY the set in KNOWN_FINDINGS: a new leak turns it red, and so does fixing a
// recorded one without striking it, so the ledger cannot go stale either way.
//
// EVERY PROBE HAS A CONTROL. The same statement against A's OWN row must succeed,
// or the refusal proves nothing (a typo, a missing fixture and a dead query all
// look like a refusal). A control that fails marks the pair INVALID -- "could not
// establish" -- never "isolated". A refusal is scored by SQLSTATE, not by "some
// error": a typo is 42703, a wrong policy is 42501.
//
// NO service_role. It bypasses row-level security completely, so a pass obtained
// with it would prove nothing. The probe never names that role, never grants to it
// and never reads its key; the static half of this file checks that the SQL it
// generates still says so. The connection is `postgres`, which is only used to
// build fixtures and to READ BACK what an attack did; every attack runs as
// `authenticated` or `anon`.
//
// NOTHING SURVIVES. The last statement is ROLLBACK, and after every live run this
// file asks the database whether any a25 row, user, company or policy is left.
// Real third-party rows are only ever COUNTED (as postgres) or looked for by the
// synthetic attacker (who must get zero); none is written, none is impersonated.
//
//   node --test tests/a25-tenant-isolation.test.mjs               STATIC only (pure, ~1 s)
//   A25_LIVE=1 node --test tests/a25-tenant-isolation.test.mjs    STATIC + LIVE: catalogue coverage, the attack, the sabotage run (~1 min)
//   A25_LIVE=1 A25_FIXES=1 node --test ...                        ...and the proposed fixes in supabase_r15_tenant_isolation_findings.sql
//                                                                 applied INSIDE the rolled-back transaction, proving they close F2-F6
//   A25_DUMP=path node ...                                        also write the probe SQL there
//   A25_VERDICT=path A25_LIVE=1 node ...                          also write the per-subject verdict there (JSON)
//
// The findings this run is expected to fail on, with who could see or change what,
// are in KNOWN_FINDINGS below and in supabase_r15_tenant_isolation_findings.sql
// (NOT APPLIED: a record plus proposed fixes, one rolled-back transaction).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PROJECT = "newcrgafcptspmapacrx";
const ROOT = process.cwd();
const LIVE = process.env.A25_LIVE === "1";

// ================================================================ ids =====
const hex = (n, w) => n.toString(16).padStart(w, "0");
/** kind 0 company, 1 user, 2 A's row, 3 B's row, 4 poison, 5 cross-parent, 6 control, 7 misc, f token */
export const uuid = (kind, idx, n = 1) => `a25${kind}${hex(idx, 2)}00-0000-4000-8000-${hex(n, 12)}`;
export const NS = /^a25[0-9a-f]{5}-0000-4000-8000-[0-9a-f]{12}$/;

const CA = uuid("0", 1), CB = uuid("0", 2), CX = uuid("0", 3), CY = uuid("0", 4);
/** Every synthetic company, as a SQL list, so a census of "the real tenants" can never count one of ours. */
const SYN = [CA, CB, CX, CY].map((c) => "'" + c + "'").join(",");
const U = {
  AO: uuid("1", 1),   // A's OWNER: the attacker
  AC: uuid("1", 2),   // A's CREW, linked to a crew record
  BO: uuid("1", 3),   // B's OWNER
  BC: uuid("1", 4),   // B's CREW, linked to a crew record
  Z: uuid("1", 5),    // signed in, has no profile at all (a fresh sign-up)
  Y: uuid("1", 6),    // signed in, has a profile with no company (a removed member)
  AM1: uuid("1", 7),  // A crew: target of set_member_role
  AM2: uuid("1", 8),  // A crew: target of release_seat
  AX: uuid("1", 9),   // removed from A: target of allow_rejoin
  AMG: uuid("1", 10), // A manager: target of set_mail_access
  BM: uuid("1", 11),  // B manager
  BX: uuid("1", 12),  // removed from B
  BM2: uuid("1", 13), // B crew: target of the attacker's role/seat calls
  ADM: uuid("1", 14), // a synthetic PLATFORM ADMIN, only to prove the admin doors do open for one
  W: uuid("1", 15),   // signed in, no company: the stranger who joins B with its id
};
const TOK_A = uuid("f", 1), TOK_B = uuid("f", 2);
/** The crew record each company's crew login is linked to. A shift must name one of its own company's. */
const EMP = { a: uuid("7", 40), b: uuid("7", 41) };
const q = (s) => `'${s}'`;
const jsq = (s) => String(s).replace(/'/g, "''");

// ============================================================ table spec ==
// One entry per tenant-owned table. `ins(co,id,job,ctx)` is the whole INSERT (no
// ON CONFLICT); it is used for the fixtures, the poison, the control and the
// cross-parent probe, so all four are the SAME statement shape. `updSet` is the
// assignment an UPDATE probe makes and `updIs` a boolean that is true once it has
// landed. `canIns`/`canUpd` say whether a tenant OWNER may write at all (from the
// live policies read on 2026-09-29); where they are false the write is closed to
// every tenant and the control expects the same refusal, so a refusal there is
// "closed", not "isolated by company". `uq` is the unique key for the upsert probe.
const tbl = (o) => ({ canIns: true, canUpd: true, job: false, single: false, adminOnly: false, uq: null, ...o });
/** rule_key is a CHECK of four values and unique per company: each kind of row (fixture, poison, control, fingerprint) gets its own, so a poison that lands cannot collide with what follows. */
const AUTOMATION_KEY = { a252: "materials_received_advance_stage", a253: "materials_received_advance_stage", a254: "quote_gone_quiet_note", a256: "quote_gone_quiet_note" };
const tokFor = (id) => (id === uuid("2", 1) ? q(TOK_A) : id === uuid("3", 1) ? q(TOK_B) : "gen_random_uuid()");

export const TABLES = [
  tbl({ t: "jobs", uq: "company_id, sync_id", updSet: "notes = 'A25 TOUCH'", updIs: "notes = 'A25 TOUCH'",
    ins: (co, id) => `insert into public.jobs(id,company_id,sync_id,customer_name,address,phone,email,status,contract_total,quote_token,is_test_fixture,notes,hoa_name,permit_number,priced_by,pricing_engine_version,estimated_duration_hours,waste_percent,updated_at) values (${q(id)},${q(co)},${q(id)},'A25 CUSTOMER','1 Probe Way','555-0100','a25@probe.invalid','ACCEPTED',5000,${tokFor(id)},false,'','','','','',4,10,'2026-01-01 00:00:00+00')` }),
  tbl({ t: "estimate_line_items", job: true, uq: "company_id, sync_id", updSet: "description = 'A25 TOUCH'", updIs: "description = 'A25 TOUCH'",
    ins: (co, id, job) => `insert into public.estimate_line_items(id,company_id,sync_id,job_sync_id,description,quantity,unit_price,role,auto_generated) values (${q(id)},${q(co)},${q(id)},${q(job)},'A25 line',1,10,'NONE',false)` }),
  tbl({ t: "fence_runs", job: true, uq: "company_id, sync_id", updSet: "label = 'A25 TOUCH'", updIs: "label = 'A25 TOUCH'",
    ins: (co, id, job) => `insert into public.fence_runs(id,company_id,sync_id,job_sync_id,label) values (${q(id)},${q(co)},${q(id)},${q(job)},'A25 run')` }),
  tbl({ t: "change_orders", job: true, uq: "company_id, sync_id", updSet: "description = 'A25 TOUCH'", updIs: "description = 'A25 TOUCH'",
    ins: (co, id, job) => `insert into public.change_orders(id,company_id,sync_id,job_sync_id,description,additional_cost) values (${q(id)},${q(co)},${q(id)},${q(job)},'A25 order',100)` }),
  tbl({ t: "payment_records", job: true, uq: "company_id, sync_id", updSet: "note = 'A25 TOUCH'", updIs: "note = 'A25 TOUCH'",
    ins: (co, id, job) => `insert into public.payment_records(id,sync_id,company_id,job_sync_id,amount,method,received_at,note,recorded_by) values (${q(id)},${q(id)},${q(co)},${q(job)},100,'check',now(),'','A25')` }),
  tbl({ t: "job_payments", job: true, updSet: "payment_url = 'https://a25.invalid/touch'", updIs: "payment_url = 'https://a25.invalid/touch'",
    ins: (co, id, job) => `insert into public.job_payments(id,company_id,job_sync_id,kind,amount_cents,currency,status) values (${q(id)},${q(co)},${q(job)},'deposit',1000,'usd','paid')` }),
  tbl({ t: "employees", uq: "company_id, sync_id", updSet: "notes = 'A25 TOUCH'", updIs: "notes = 'A25 TOUCH'",
    ins: (co, id) => `insert into public.employees(id,company_id,name,sync_id,hourly_rate,pay_type,is_active) values (${q(id)},${q(co)},'A25 person',${q(id)},20,'HOURLY',true)` }),
  tbl({ t: "time_entries", job: true, uq: "company_id, sync_id", updSet: "notes = 'A25 TOUCH'", updIs: "notes = 'A25 TOUCH'",
    ins: (co, id, job) => `insert into public.time_entries(id,company_id,sync_id,job_sync_id,employee_sync_id,started_at,ended_at,hourly_rate,notes,updated_at) values (${q(id)},${q(co)},${q(id)},${q(job)},${q(co === CA ? EMP.a : EMP.b)},now()-interval '9 hours',now()-interval '1 hour',20,'',now())` }),
  tbl({ t: "material_items", uq: "company_id, sync_id", updSet: "name = 'A25 TOUCH'", updIs: "name = 'A25 TOUCH'",
    ins: (co, id) => `insert into public.material_items(id,company_id,sync_id,name,unit_price) values (${q(id)},${q(co)},${q(id)},'A25 item',1)` }),
  tbl({ t: "customers", uq: "company_id, sync_id", updSet: "notes = 'A25 TOUCH'", updIs: "notes = 'A25 TOUCH'",
    ins: (co, id) => `insert into public.customers(id,company_id,name,address,phone,email,notes,sync_id) values (${q(id)},${q(co)},'A25 CUSTOMER','1 Probe Way','555-0100','a25@probe.invalid','',${q(id)})` }),
  tbl({ t: "expenses", job: true, uq: "company_id, sync_id", updSet: "description = 'A25 TOUCH'", updIs: "description = 'A25 TOUCH'",
    ins: (co, id, job) => `insert into public.expenses(id,company_id,sync_id,job_sync_id,description,amount) values (${q(id)},${q(co)},${q(id)},${q(job)},'A25 expense',1)` }),
  tbl({ t: "punch_list_items", job: true, uq: "company_id, sync_id", updSet: "description = 'A25 TOUCH'", updIs: "description = 'A25 TOUCH'",
    ins: (co, id, job) => `insert into public.punch_list_items(id,company_id,sync_id,job_sync_id,description) values (${q(id)},${q(co)},${q(id)},${q(job)},'A25 punch')` }),
  tbl({ t: "site_markers", job: true, uq: "company_id, sync_id", updSet: "label = 'A25 TOUCH'", updIs: "label = 'A25 TOUCH'",
    ins: (co, id, job) => `insert into public.site_markers(id,company_id,sync_id,job_sync_id,label) values (${q(id)},${q(co)},${q(id)},${q(job)},'A25 marker')` }),
  tbl({ t: "job_steps", job: true, uq: "company_id, sync_id", updSet: "description = 'A25 TOUCH'", updIs: "description = 'A25 TOUCH'",
    ins: (co, id, job) => `insert into public.job_steps(id,company_id,sync_id,job_sync_id,description) values (${q(id)},${q(co)},${q(id)},${q(job)},'A25 step')` }),
  tbl({ t: "field_changes", job: true, uq: "company_id, sync_id", updSet: "summary = 'A25 TOUCH'", updIs: "summary = 'A25 TOUCH'",
    ins: (co, id, job) => `insert into public.field_changes(id,company_id,sync_id,job_sync_id,summary,detail,changed_by,changed_by_role,at) values (${q(id)},${q(co)},${q(id)},${q(job)},'A25 change','','A25','OWNER',now())` }),
  tbl({ t: "manufacturers", uq: "company_id, sync_id", updSet: "name = 'A25 TOUCH'", updIs: "name = 'A25 TOUCH'",
    ins: (co, id) => `insert into public.manufacturers(id,company_id,sync_id,name) values (${q(id)},${q(co)},${q(id)},'A25 maker')` }),
  tbl({ t: "pricing_tiers", uq: "company_id, sync_id", updSet: "name = 'A25 TOUCH'", updIs: "name = 'A25 TOUCH'",
    ins: (co, id) => `insert into public.pricing_tiers(id,company_id,sync_id,name) values (${q(id)},${q(co)},${q(id)},'A25 tier')` }),
  tbl({ t: "build_templates", uq: "company_id, sync_id) where (company_id is not null", updSet: "name = 'A25 TOUCH'", updIs: "name = 'A25 TOUCH'",
    ins: (co, id) => `insert into public.build_templates(id,sync_id,company_id,name,fence_type,panel_width_ft,panel_height_ft,post_spacing_ft) values (${q(id)},${q(id)},${q(co)},'A25 template','VINYL',6,6,6)` }),
  // used_by must equal the caller (a policy term of its own), so every row the ATTACKER inserts names the
  // attacker, and only B's fixture names B: the only thing that can refuse the poison is its company_id.
  tbl({ t: "build_template_uses", canUpd: false, where: (p, co, id) => `template_sync_id = '${id}'`,
    ins: (co, id) => `insert into public.build_template_uses(company_id,template_sync_id,fence_type,used_by) values (${q(co)},${q(id)},'VINYL',${q(id.startsWith("a253") ? U.BO : U.AO)})` }),
  tbl({ t: "pricing_drift", job: true, updSet: "office_engine = 'a25-touch'", updIs: "office_engine = 'a25-touch'",
    ins: (co, id, job) => `insert into public.pricing_drift(id,company_id,job_sync_id) values (${q(id)},${q(co)},${q(job)})` }),
  // ---- one row per company: the generator places the fixtures, see `single`
  tbl({ t: "company_settings", single: true, where: (p, co) => `company_id = ${q(co)}`, updSet: `settings = '{"a25":1}'::jsonb`, updIs: `settings = '{"a25":1}'::jsonb`,
    ins: (co) => `insert into public.company_settings(company_id,settings) values (${q(co)},'{"a25":0}')` }),
  tbl({ t: "follow_up_settings", single: true, canIns: false, canUpd: false, where: (p, co) => `company_id = ${q(co)}`,
    ins: (co) => `insert into public.follow_up_settings(company_id) values (${q(co)})` }),
  tbl({ t: "attention_sweep_settings", single: true, canIns: false, canUpd: false, where: (p, co) => `company_id = ${q(co)}`,
    ins: (co) => `insert into public.attention_sweep_settings(company_id) values (${q(co)})` }),
  // ---- read-only to tenants (no INSERT/UPDATE policy): the server writes these
  tbl({ t: "attention_findings", job: true, canIns: false, canUpd: false,
    ins: (co, id, job) => `insert into public.attention_findings(id,company_id,job_sync_id,detector,message,fp) values (${q(id)},${q(co)},${q(job)},'a25','A25 finding','fp-${id}')` }),
  tbl({ t: "automation_flags", job: true, canIns: false, canUpd: false,
    ins: (co, id, job) => `insert into public.automation_flags(id,company_id,job_sync_id,rule_key,message) values (${q(id)},${q(co)},${q(job)},'a25_rule','A25 flag')` }),
  tbl({ t: "automation_rules", canIns: false, canUpd: false,
    ins: (co, id) => `insert into public.automation_rules(id,company_id,rule_key) values (${q(id)},${q(co)},'${AUTOMATION_KEY[id.slice(0, 4)] ?? "materials_missing_scheduled_flag"}')` }),
  tbl({ t: "automation_runs", job: true, canIns: false, canUpd: false,
    ins: (co, id, job) => `insert into public.automation_runs(id,company_id,rule_key,job_sync_id) values (${q(id)},${q(co)},'a25_run_${id.slice(0, 8)}',${q(job)})` }),
  tbl({ t: "audit_log", canIns: false, canUpd: false, where: (p, co, id) => `record_id = '${id}'`,
    ins: (co, id) => `insert into public.audit_log(company_id,table_name,record_id,action,label) values (${q(co)},'a25','${id}','insert','A25 audit')` }),
  tbl({ t: "device_keys", canIns: false, canUpd: false,
    ins: (co, id) => `insert into public.device_keys(id,company_id,code) values (${q(id)},${q(co)},'A25${id.slice(3, 8).toUpperCase()}')` }),
  tbl({ t: "follow_up_log", job: true, canIns: false, canUpd: false,
    ins: (co, id, job) => `insert into public.follow_up_log(id,company_id,job_sync_id,kind,stage_key) values (${q(id)},${q(co)},${q(job)},'approved_no_deposit','s-${id.slice(0, 8)}')` }),
  tbl({ t: "job_stage_events", job: true, canIns: false, canUpd: false,
    ins: (co, id, job) => `insert into public.job_stage_events(id,company_id,job_sync_id,stage) values (${q(id)},${q(co)},${q(job)},'DIG')` }),
  // job_id is a real FK with ON DELETE CASCADE. It points at a job of its own, not the one the jobs probes attack: under the
  // sabotage run those deletes succeed, and would take this row with them.
  tbl({ t: "quote_reapprovals", job: true, canIns: false, canUpd: false,
    ins: (co, id, job) => {
      const parent = uuid("7", co === CA ? 160 : 161);
      return `with pj as (insert into public.jobs(id,company_id,sync_id,customer_name,status,contract_total,is_test_fixture) values (${q(parent)},${q(co)},${q(parent)},'A25 PARENT','DRAFT',0,false) on conflict (id) do nothing returning id) insert into public.quote_reapprovals(id,company_id,job_id,job_sync_id) values (${q(id)},${q(co)},${q(parent)},${q(job)})`;
    } }),
  tbl({ t: "sync_signals", canIns: false, canUpd: false, where: (p, co, id) => `sync_id = '${id}'`,
    ins: (co, id) => `insert into public.sync_signals(company_id,table_name,sync_id) values (${q(co)},'a25','${id}')` }),
  // RLS with no policy at all: nothing reads it, not even its own company (the server does). So the control for a read is the database owner.
  tbl({ t: "invite_sends", canIns: false, canUpd: false, noRead: true, where: (p, co, id) => `email_hash = 'a25-${id}'`,
    ins: (co, id) => `insert into public.invite_sends(company_id,email_hash) values (${q(co)},'a25-${id}')` }),
  // ---- company email: a tenant reads it through can_use_company_mail(), never writes it
  // One FenceFlow-hosted account per company is a unique index, so the second row (the fingerprint control) is an IMAP one.
  tbl({ t: "mail_accounts", canIns: false, canUpd: false,
    ins: (co, id) => id.startsWith("a258")
      ? `insert into public.mail_accounts(id,company_id,kind,provider,email_address,username,imap_host,smtp_host,status) values (${q(id)},${q(co)},'imap','custom','a25-${id.slice(3, 8)}@probe.invalid','a25','imap.probe.invalid','smtp.probe.invalid','connected')`
      : `insert into public.mail_accounts(id,company_id,kind,provider,email_address,inbound_token,status) values (${q(id)},${q(co)},'fenceflow','resend','a25-${id.slice(3, 8)}@probe.invalid','${id.replace(/-/g, "").slice(0, 24)}','connected')` }),
  tbl({ t: "mail_threads", canIns: false, canUpd: false,
    ins: (co, id) => `insert into public.mail_threads(id,company_id,subject) values (${q(id)},${q(co)},'A25 thread')` }),
  tbl({ t: "mail_messages", canIns: false, canUpd: false, mail: true,
    ins: (co, id, job, ctx) => `insert into public.mail_messages(id,company_id,account_id,thread_id,folder_role,source,provider_message_id,received_at,subject) values (${q(id)},${q(co)},${q(ctx.acct)},${q(ctx.thread)},'inbox','resend_inbound','a25-${id}',now(),'A25 mail')` }),
  tbl({ t: "mail_thread_jobs", job: true, canIns: false, canUpd: false, mail: true, byCompanyOnly: true, where: (p, co, id, ctx) => `thread_id = ${q(ctx.thread)}`,
    ins: (co, id, job, ctx) => `insert into public.mail_thread_jobs(thread_id,company_id,job_sync_id) values (${q(ctx.thread)},${q(co)},${q(job)})` }),
  tbl({ t: "mail_access", canIns: false, canUpd: false, mail: true, byCompanyOnly: true, where: (p, co, id, ctx) => `profile_id = ${q(ctx.member)}`,
    ins: (co, id, job, ctx) => `insert into public.mail_access(company_id,profile_id,allowed,set_by) values (${q(co)},${q(ctx.member)},true,${q(ctx.member)})` }),
  // ---- readable by the platform operator only; the control is the operator reading it
  tbl({ t: "company_setup_codes", adminOnly: true, canIns: false, canUpd: false, where: (p, co, id) => `code = 'A25-${id.slice(3, 8).toUpperCase()}'`,
    ins: (co, id) => `insert into public.company_setup_codes(code,company_id) values ('A25-${id.slice(3, 8).toUpperCase()}',${q(co)})` }),
];
TABLES.forEach((s, i) => { s.i = i + 1; });
export const TABLE_NAMES = TABLES.map((s) => s.t);

/** Tables no tenant login may touch at all: no grant to authenticated or anon. */
export const NO_GRANT_TABLES = ["payment_connections", "mail_account_secrets", "mail_events", "mail_folder_state",
  "mail_inbound_events", "mail_platform_settings"];
/** Tables a login can SELECT from but whose only policy is the platform operator's, so a tenant sees nothing. */
export const OPERATOR_ONLY_TABLES = ["auth_events", "auth_events_suppressed"];
/**
 * Tables in the supabase_realtime publication whose changes are attacked through realtime.apply_rls() above. sync_signals is in the
 * publication too but carries no row id and no payload (company_id, table name, a key, a time), so the builder cannot describe a
 * change to it; the LIVE coverage test says so rather than letting it drop out unnoticed.
 */
export const REALTIME_TABLES = ["jobs", "estimate_line_items", "fence_runs", "change_orders", "payment_records", "job_payments", "employees",
  "time_entries", "material_items", "expenses", "punch_list_items", "site_markers", "job_steps", "field_changes", "pricing_tiers", "profiles"];
export const REALTIME_UNPROBED = { sync_signals: "no row id and no payload (company_id, table name, key, time); nothing to read" };
/** Views over tenant data, owned by the DB owner (they bypass RLS on their own), scoped by their WHERE. */
export const CREW_VIEWS = ["jobs_crew", "estimate_line_items_crew", "change_orders_crew", "material_items_crew", "time_entries_crew"];

// ============================================================ builder =====
const L = (s) => `'${jsq(s)}'`;

/** SQL prelude: the result table, the impersonation helpers, the scorer, the digest. */
const PRELUDE = `
begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

create temp table r(n serial primary key, tbl text, pair text, role text, k text, got text, want text);
grant all on r to authenticated, anon;
grant usage on sequence r_n_seq to authenticated, anon;
create temp table snap(k text primary key, v text);

-- The caller's JWT and role are set INLINE in each helper: once the role is
-- switched, another pg_temp function may not be callable, so nothing is called
-- between "set local role" and "reset role". A null "who" is the anon key.
-- One scalar back.
create function pg_temp.q(tb text, pr text, ro text, kk text, who uuid, sq text, wt text) returns void language plpgsql as $fn$
declare v text;
begin
  if who is null then
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    execute 'set local role anon';
  else
    perform set_config('request.jwt.claims', json_build_object('sub',who,'role','authenticated','aud','authenticated')::text, true);
    execute 'set local role authenticated';
  end if;
  begin execute sq into v; v := coalesce(v,'NULL');
  exception when others then v := 'ERR ' || sqlstate || ': ' || left(sqlerrm,140); end;
  execute 'reset role';
  perform set_config('request.jwt.claims','',true);
  insert into r(tbl,pair,role,k,got,want) values (tb,pr,ro,kk,v,wt);
end $fn$;

-- The same, run for effect: the real affected-row count.
create function pg_temp.x(tb text, pr text, ro text, kk text, who uuid, sq text, wt text) returns void language plpgsql as $fn$
declare c int; v text;
begin
  if who is null then
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    execute 'set local role anon';
  else
    perform set_config('request.jwt.claims', json_build_object('sub',who,'role','authenticated','aud','authenticated')::text, true);
    execute 'set local role authenticated';
  end if;
  begin execute sq; get diagnostics c = row_count; v := 'rows=' || c;
  exception when others then v := 'ERR ' || sqlstate || ': ' || left(sqlerrm,140); end;
  execute 'reset role';
  perform set_config('request.jwt.claims','',true);
  insert into r(tbl,pair,role,k,got,want) values (tb,pr,ro,kk,v,wt);
end $fn$;

-- The reading-back side: the database owner, no JWT. It never attacks; it only
-- looks at what an attack did (or did not do).
create function pg_temp.s(tb text, pr text, ro text, kk text, sq text, wt text) returns void language plpgsql as $fn$
declare v text;
begin
  perform set_config('request.jwt.claims','',true);
  begin execute sq into v; v := coalesce(v,'NULL');
  exception when others then v := 'ERR ' || sqlstate || ': ' || left(sqlerrm,140); end;
  insert into r(tbl,pair,role,k,got,want) values (tb,pr,ro,kk,v,wt);
end $fn$;

-- A fingerprint of every row a company owns in one table.
create function pg_temp.dig(tb text, co uuid) returns text language plpgsql as $fn$
declare v text;
begin
  execute format('select coalesce(md5(string_agg(md5(x::text), '''' order by md5(x::text))), ''-'') from public.%I x where company_id = %L', tb, co) into v;
  return v;
end $fn$;

-- Realtime, the second way to read a row: Postgres-Changes hands every change to realtime.apply_rls(),
-- which decides which subscriptions receive it. The function below is the P4 probe's builder of a wal2json
-- record (supabase_p4_realtime_probe.sql), unchanged; it reads one existing row and describes its change.
create temp table rt_out(wal jsonb, is_rls bool, sids uuid[], errors text[]);
create temp table rt_subs(label text, sid uuid, tbl regclass);
create function pg_temp.wal(act text, tbl regclass, rid uuid, ri text,
                            new_over jsonb default '{}', old_over jsonb default '{}')
returns jsonb language plpgsql as $fn$
declare expr text; rowj jsonb; newj jsonb; oldj jsonb; cols jsonb; ident jsonb; pk jsonb; pkatt int2[];
begin
  select string_agg(format('jsonb_build_object(%s)', parts), ' || ') into expr from (
    select (n-1)/40 grp, string_agg(format('%L, x.%I::text', attname, attname), ', ' order by n) parts
      from (select attname, row_number() over (order by attnum) n
              from pg_attribute where attrelid = tbl and attnum > 0 and not attisdropped) s
     group by grp) g;
  execute format('select %s from %s x where x.id = $1', expr, tbl) into rowj using rid;
  if rowj is null then raise exception 'fixture % % missing', tbl, rid; end if;
  newj := rowj || new_over;
  oldj := rowj || old_over;
  if ri = 'live' then select relreplident::text into ri from pg_class where oid = tbl; end if;
  select conkey into pkatt from pg_constraint where conrelid = tbl and contype = 'p';

  select jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,null),
                   'typeoid',a.atttypid::int,'value',newj->a.attname) order by a.attnum)
    into cols from pg_attribute a where a.attrelid = tbl and a.attnum > 0 and not a.attisdropped;
  select jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,null),
                   'typeoid',a.atttypid::int,'value',oldj->a.attname) order by a.attnum)
    into ident from pg_attribute a where a.attrelid = tbl and a.attnum > 0 and not a.attisdropped
     and (ri = 'f' or (ri in ('d','i') and a.attnum = any(pkatt)));
  select jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,null),
                   'typeoid',a.atttypid::int) order by a.attnum)
    into pk from pg_attribute a where a.attrelid = tbl and a.attnum = any(pkatt);

  return jsonb_build_object('action', act,
           'timestamp', to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD HH24:MI:SS.US') || '+00',
           'schema', (select n.nspname from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.oid = tbl),
           'table', (select relname from pg_class where oid = tbl),
           'pk', pk)
      || case when act in ('I','U') then jsonb_build_object('columns', cols) else '{}'::jsonb end
      || case when act in ('U','D') and ident is not null then jsonb_build_object('identity', ident) else '{}'::jsonb end;
end $fn$;

-- Register a subscription the way the Realtime server does, and say whether the DEPLOYED apply_rls
-- delivers one change to it: '1' delivered, '0' not.
create function pg_temp.rt_sub(lb text, uid uuid, tb regclass, filt realtime.user_defined_filter[]) returns void language plpgsql as $fn$
declare sid uuid := gen_random_uuid();
begin
  insert into realtime.subscription(subscription_id, entity, filters, claims, action_filter)
  values (sid, tb, coalesce(filt, '{}'),
          case when uid is null then jsonb_build_object('role', 'anon', 'exp', extract(epoch from now() + interval '1 hour')::bigint)
               else jsonb_build_object('sub', uid, 'role', 'authenticated', 'exp', extract(epoch from now() + interval '1 hour')::bigint) end,
          '*');
  insert into rt_subs values (lb, sid, tb);
end $fn$;
create function pg_temp.rt_delivered(lb text, w jsonb) returns text language plpgsql as $fn$
declare n int; sid uuid;
begin
  select rs.sid into sid from rt_subs rs where rs.label = lb;
  if sid is null then return 'NO SUCH SUBSCRIPTION'; end if;
  delete from rt_out;
  insert into rt_out select * from realtime.apply_rls(w);
  select count(*) into n from rt_out where sid = any(sids);
  -- apply_rls leaves the last subscriber's role and claims behind; the owner-of-the-database steps that follow must not inherit them.
  execute 'reset role';
  perform set_config('request.jwt.claims','',true);
  return n::text;
end $fn$;

-- want: an exact string; 'ERR <sqlstate>' (prefix); '>=N'; 'info' (recorded, never
-- fails); or several of those joined with '|'.
create function pg_temp.ok(got text, want text) returns boolean language sql immutable as $fn$
  select coalesce((
    select bool_or(case
      when alt = 'info' then true
      when alt like '>=%' then case when got ~ '^[0-9]+$' then got::numeric >= substr(alt,3)::numeric else false end
      when alt like 'ERR %' then got like alt || '%'
      else got = alt end)
    from unnest(string_to_array(want, '|')) as alt), false)
$fn$;
`;

const EPILOGUE = `
select n, tbl, pair, role, k, got, want, case when pg_temp.ok(got, want) then 'PASS' else 'FAIL' end as result from r
union all
select 1000000, 'SUMMARY', '-', '-', 'passed/total',
       (select count(*) filter (where pg_temp.ok(got, want))::text || '/' || count(*)::text from r), '-', '-'
 order by 1;

rollback;
`;

/**
 * The whole probe as one SQL text plus the list of checks it makes. \`sabotage\`
 * puts a permissive USING (true) policy on every tenant table first, which is
 * what an accidental "allow all" would look like: the isolation checks must then
 * go red, or they never had teeth.
 */
export function buildProbe({ sabotage = false } = {}) {
  const body = [];
  const checks = [];
  const emit = (s) => body.push(s);
  const rid = (party, s) => uuid(party === "a" ? "2" : "3", s.i);
  const co = (p) => (p === "a" ? CA : CB);
  const jobOf = (p) => rid(p, TABLES[0]);
  const byName = Object.fromEntries(TABLES.map((s) => [s.t, s]));
  const ctxOf = (p) => ({
    acct: rid(p, byName.mail_accounts), thread: rid(p, byName.mail_threads), member: p === "a" ? U.AMG : U.BM,
  });
  const whereOf = (s, p, id = rid(p, s)) => (s.where ? s.where(p, co(p), id, ctxOf(p)) : `id = ${q(id)}`);

  /** One recorded check. fn: q (scalar as who), x (effect as who), s (scalar as the owner of the database). */
  const chk = (fn, tb, pair, role, k, who, sql, want) => {
    checks.push({ tbl: tb, pair, role, k, want, who });
    if (fn === "s") emit(`  perform pg_temp.s(${L(tb)},${L(pair)},${L(role)},${L(k)},$q$${sql}$q$,${L(want)});`);
    else emit(`  perform pg_temp.${fn}(${L(tb)},${L(pair)},${L(role)},${L(k)},${who === null ? "null::uuid" : q(who) + "::uuid"},$q$${sql}$q$,${L(want)});`);
  };
  const count = (t, where) => `select count(*)::text from ${t} where ${where}`;

  // ------------------------------------------------------------ fixtures --
  emit(`  perform set_config('request.jwt.claims','',true);`);
  emit(`  -- Users, companies, members. Every id is a25xxxxx-0000-4000-8000-..., every address is @probe.invalid.`);
  const users = Object.entries(U).map(([k, v]) => `(${q(v)},'a25-${k.toLowerCase()}@probe.invalid')`).concat([`(${q(uuid("1", 30))},'a25-n@probe.invalid')`]);
  emit(`  insert into auth.users(id,email) values ${users.join(",")};`);
  const coRow = (id, name, lead) =>
    `(${q(id)},${L(name)},'active','pro',false,now()+interval '30 days','',${q(lead)},'cus_A25','','')`;
  emit(`  insert into public.companies(id,name,subscription_status,subscription_plan,suspended,trial_ends_at,admin_notes,leads_token,stripe_customer_id,invited_email,suspended_reason) values
    ${coRow(CA, "PROBE-A25-ATTACKER", uuid("f", 3))}, ${coRow(CB, "PROBE-A25-VICTIM", uuid("f", 4))}, ${coRow(CX, "PROBE-A25-OPERATOR", uuid("f", 5))}, ${coRow(CY, "PROBE-A25-EMPTY", uuid("f", 6))};`);
  const prof = (id, c, name, role, extra = "null") => `(${q(id)},${c ? q(c) : "null"},${L(name)},'${role}',false,'',${extra})`;
  emit(`  insert into public.profiles(id,company_id,full_name,role,is_platform_admin,permission_overrides,removed_from_company_id) values
    ${prof(U.AO, CA, "A25 Owner A", "OWNER")}, ${prof(U.AC, CA, "A25 Crew A", "CREW")}, ${prof(U.AM1, CA, "A25 Member A1", "CREW")},
    ${prof(U.AM2, CA, "A25 Member A2", "CREW")}, ${prof(U.AMG, CA, "A25 Manager A", "MANAGER")},
    ${prof(U.AX, null, "A25 Removed A", "CREW", q(CA))},
    ${prof(U.BO, CB, "A25 Owner B", "OWNER")}, ${prof(U.BC, CB, "A25 Crew B", "CREW")}, ${prof(U.BM, CB, "A25 Manager B", "MANAGER")},
    ${prof(U.BM2, CB, "A25 Member B2", "CREW")}, ${prof(U.BX, null, "A25 Removed B", "CREW", q(CB))},
    ${prof(U.Y, null, "A25 No Company", "CREW")};`);
  // A synthetic PLATFORM ADMIN, in a company of its own: only so the admin doors
  // have a positive control. It is inserted with the flag set by the database owner
  // (the protecting trigger lets a caller with no JWT through), never granted to a tenant.
  emit(`  insert into public.profiles(id,company_id,full_name,role,is_platform_admin,permission_overrides) values (${q(U.ADM)},${q(CX)},'A25 Operator','OWNER',true,'');`);
  // Crew records linked to the two crew logins.
  const eAC = EMP.a, eBC = EMP.b;
  emit(`  insert into public.employees(id,company_id,name,sync_id,hourly_rate,pay_type,profile_id,is_active) values
    (${q(eAC)},${q(CA)},'A25 Crew A',${q(eAC)},21,'HOURLY',${q(U.AC)},true), (${q(eBC)},${q(CB)},'A25 Crew B',${q(eBC)},21,'HOURLY',${q(U.BC)},true);`);

  // Per-table fixtures. One-row-per-company tables are placed by the generator
  // (B's after A's poison attempt), everything else is here.
  for (const s of TABLES) {
    if (s.single) continue;
    for (const p of ["a", "b"]) emit(`  ${s.ins(co(p), rid(p, s), jobOf(p), ctxOf(p))};`);
  }
  emit(`  insert into public.device_tokens(token,user_id,company_id) values ('a25-token-b',${q(U.BO)},${q(CB)});`);
  emit(`  insert into public.notification_prefs(user_id) values (${q(U.BO)});`);
  emit(`  insert into public.app_errors(company_id,reported_by,email,message) values (${q(CB)},${q(U.BO)},'a25-bo@probe.invalid','A25 fixture error');`);
  emit(`  insert into storage.objects(bucket_id,name,owner,metadata) values
    ('job-files','${CA}/${jobOf("a")}/a25/probe-a.txt',${q(U.AO)},'{"size":1}'), ('job-files','${CB}/${jobOf("b")}/a25/probe-b.txt',${q(U.BO)},'{"size":1}');`);

  if (sabotage) {
    emit(`  -- SABOTAGE: an accidental "allow all". Every isolation check on these tables must now go red.`);
    for (const t of [...TABLE_NAMES, "companies", "profiles"]) {
      emit(`  create policy zz_a25_sabotage_${t} on public.${t} as permissive for all to public using (true) with check (true);`);
    }
  }

  // ------------------------------------ realtime: the change feed is a second way to read a row (first, while every fixture row still exists: the sabotage run deletes them) --
  // The deployed realtime.apply_rls() is handed a change to one of B's rows and asked which subscriptions receive it.
  // Subscribers: A's owner with no filter, A's owner naming B's company in a filter, and the anon key.
  for (const t of REALTIME_TABLES) {
    const s = byName[t];
    const tid = (p) => (t === "profiles" ? (p === "a" ? U.AO : U.BO) : rid(p, s));
    const reg = `'public.${t}'::regclass`;
    emit(`  perform pg_temp.rt_sub('A:${t}', ${q(U.AO)}::uuid, ${reg}, null);`);
    emit(`  perform pg_temp.rt_sub('Afb:${t}', ${q(U.AO)}::uuid, ${reg}, array[('company_id','eq',${q(CB)},false)::realtime.user_defined_filter]);`);
    emit(`  perform pg_temp.rt_sub('anon:${t}', null, ${reg}, null);`);
    const w = (act, p) => `pg_temp.wal('${act}', ${reg}, ${q(tid(p))}::uuid, 'live')`;
    const dl = (lb, act, p) => `select pg_temp.rt_delivered('${lb}:${t}', ${w(act, p)})`;
    const name = `realtime.${t}`;
    for (const act of ["I", "U"]) {
      const pair = act === "I" ? "ins_b" : "upd_b";
      const verb = act === "I" ? "an INSERT" : "an UPDATE";
      chk("s", name, pair, "probe", `A's owner, subscribed with no filter, is handed ${verb} to B's row`, null, dl("A", act, "b"), "0");
      chk("s", name, pair, "probe", `A's owner, subscribed with company_id = B in the filter, is handed ${verb} to B's row`, null, dl("Afb", act, "b"), "0");
      chk("s", name, pair, "probe", `the anon key is handed ${verb} to B's row`, null, dl("anon", act, "b"), "0");
      chk("s", name, pair, "control", `A's owner is handed ${verb} to A's own row (the feed is live and delivers to a member)`, null, dl("A", act, "a"), "1");
    }
  }

  // ------------------------------------------------- per-table isolation --
  for (const s of TABLES) {
    const t = `public.${s.t}`;
    const A = U.AO, B = U.BO;
    const whA = whereOf(s, "a"), whB = whereOf(s, "b");
    const poison = uuid("4", s.i), ctl = uuid("6", s.i), cross = uuid("5", s.i), sens = uuid("8", s.i);
    const whPoison = whereOf(s, "b", poison);
    const censusReal = `select count(*)::text from ${t} where company_id is not null and company_id not in (${SYN})`;

    // SINGLE-row tables: the poison goes first (B has no row yet, so a wrongly
    // allowed insert would land), A's own row is the control insert, B's row follows.
    if (s.single) {
      chk("x", s.t, "ins_b", "probe", "insert one row for B as A's owner (B has none yet)", A, s.ins(CB), "ERR 42501");
      chk("s", s.t, "ins_b", "readback", "B still has no row", null, count(t, `company_id = ${q(CB)}`), "0");
      chk("x", s.t, "ins_b", "control", "insert one row for A as A's owner", A, s.ins(CA), s.canIns ? "rows=1" : "ERR 42501");
      // (on conflict: under the sabotage run the poison above LANDS, and the fixture must not then collide with it)
      emit(`  ${s.ins(CB)} on conflict do nothing;`);
      if (!s.canIns) emit(`  ${s.ins(CA)} on conflict do nothing;`);   // A cannot insert here, so the owner of the database places A's row
    }

    emit(`  insert into snap values (${L(s.t + ":b")}, pg_temp.dig(${L(s.t)}, ${q(CB)}));`);

    // ---- reads. A table nobody may read (RLS, no policy) is controlled by the owner of the database.
    const rc = (pair, label, who, sql, want) => s.noRead
      ? chk("s", s.t, pair, "control", label + " (read by the database owner: no tenant has a read policy here)", null, sql, want)
      : chk("q", s.t, pair, "control", label, who, sql, want);
    if (s.adminOnly) {
      chk("q", s.t, "sel_b", "probe", "A's owner reads B's row", A, count(t, whB), "0");
      chk("q", s.t, "sel_b", "control", "the platform operator reads B's row", U.ADM, count(t, whB), "1");
    } else {
      chk("q", s.t, "sel_b", "probe", "A's owner reads B's row by its key", A, count(t, whB), "0");
      rc("sel_b", "A's row exists and is read by its key", A, count(t, whA), "1");
    }
    chk("q", s.t, "sel_any", "probe", "A's owner reads every row carrying B's company_id", A, count(t, `company_id = ${q(CB)}`), "0");
    if (s.adminOnly) chk("q", s.t, "sel_any", "control", "the platform operator reads every row carrying B's company_id", U.ADM, count(t, `company_id = ${q(CB)}`), ">=1");
    else rc("sel_any", "A's rows are read by company_id", A, count(t, `company_id = ${q(CA)}`), ">=1");
    chk("q", s.t, "sel_real", "probe", "A's owner reads every row that is not A's (this takes in the real tenants)", A, count(t, `company_id is not null and company_id <> ${q(CA)}`), "0");
    chk("s", s.t, "sel_real", "info", "rows that belong to real tenants and were out of the attacker's reach", null, censusReal, "info");
    chk("q", s.t, "sel_null", "probe", "A's owner reads rows with no company at all", A, count(t, "company_id is null"), s.t === "build_templates" ? "info" : "0");
    chk("s", s.t, "sel_null", "info", "rows with no company at all (real data; build_templates' shipped catalogue is public on purpose)", null, count(t, "company_id is null"), "info");
    if (!s.adminOnly) {
      chk("q", s.t, "sel_sym", "probe", "B's owner reads every row carrying A's company_id", B, count(t, `company_id = ${q(CA)}`), "0");
      rc("sel_sym", "B's rows are read by company_id", B, count(t, `company_id = ${q(CB)}`), ">=1");
    }
    for (const [who, label] of [[null, "the anon key"], [U.Z, "a signed-in stranger with no profile"], [U.Y, "a signed-in person whose profile has no company"]]) {
      const pair = who === null ? "anon" : who === U.Z ? "nocompany_z" : "nocompany_y";
      chk("q", s.t, pair, "probe", `${label} reads every tenant row`, who, count(t, "company_id is not null"), "0|ERR 42501");
      chk("s", s.t, pair, "control", "the table holds tenant rows (read by the database owner)", null, count(t, "company_id is not null"), ">=1");
    }

    // ---- writes
    const closed = "rows=0|ERR 42501";
    const noop = "company_id = company_id";
    const set = s.canUpd ? s.updSet : noop;
    if (s.t === "device_keys") {
      // Within one company, not across two: the owner mints keys through list_device_keys() (owner/manager only), but the TABLE's read policy has no role in it.
      chk("q", s.t, "crew_read", "probe", "B's own CREW login reads B's unused device keys straight from the table", U.BC, count(t, `company_id = ${q(CB)}`), "0");
      chk("q", s.t, "crew_read", "control", "B's OWNER reads the same table", U.BO, count(t, `company_id = ${q(CB)}`), ">=1");
    }
    chk("x", s.t, "upd_b", "probe", "A's owner updates B's row", A, `update ${t} set ${set} where ${whB}`, s.canUpd ? "rows=0" : closed);
    if (s.canUpd) chk("s", s.t, "upd_b", "readback", "B's row exists and was not changed", null, count(t, `${whB} and not (${s.updIs})`), "1");
    else chk("s", s.t, "upd_b", "readback", "B's row still exists", null, count(t, whB), "1");
    chk("x", s.t, "upd_b", "control", "A's owner updates A's own row", A, `update ${t} set ${set} where ${whA}`, s.canUpd ? "rows=1" : closed);
    if (s.canUpd) chk("s", s.t, "upd_b", "control", "A's row changed", null, count(t, `${whA} and (${s.updIs})`), "1");

    chk("x", s.t, "del_b", "probe", "A's owner deletes B's row", A, `delete from ${t} where ${whB}`, closed);
    chk("s", s.t, "del_b", "readback", "B's row survived", null, count(t, whB), "1");
    chk("x", s.t, "del_b", "control", "A's owner deletes A's own row (deletes are closed to every tenant: soft-delete only)", A, `delete from ${t} where ${whA}`, closed);
    chk("s", s.t, "del_b", "control", "A's row survived too", null, count(t, whA), "1");

    if (!s.single) {
      chk("x", s.t, "ins_b", "probe", "A's owner inserts a row carrying B's company_id (tenant poisoning)", A, s.ins(CB, poison, jobOf("b"), ctxOf("b")), "ERR 42501");
      // A row with no id of its own (a link, an access grant) cannot be found by key; the b_unchanged fingerprint below covers it.
      if (!s.byCompanyOnly) chk("s", s.t, "ins_b", "readback", "the poison row is not in B", null, count(t, `${whPoison} and company_id = ${q(CB)}`), "0");
      chk("x", s.t, "ins_b", "control", s.canIns ? "the same insert carrying A's own company_id" : "the same insert carrying A's own company_id (closed to every tenant)",
        A, s.ins(CA, ctl, jobOf("a"), ctxOf("a")), s.canIns ? "rows=1" : "ERR 42501");
    }

    if (s.canUpd) {
      chk("x", s.t, "mv_out", "probe", "A's owner moves A's own row INTO company B", A, `update ${t} set company_id = ${q(CB)} where ${whA}`, "ERR 42501");
      chk("s", s.t, "mv_out", "readback", "A's row is still A's", null, count(t, `${whA} and company_id = ${q(CA)}`), "1");
      chk("x", s.t, "mv_out", "control", "A's owner updates A's own row (the update path is live)", A, `update ${t} set ${s.updSet} where ${whA}`, "rows=1");
      chk("x", s.t, "mv_in", "probe", "A's owner pulls B's row INTO company A", A, `update ${t} set company_id = ${q(CA)} where ${whB}`, "rows=0");
      chk("s", s.t, "mv_in", "readback", "B's row is still B's", null, count(t, `${whB} and company_id = ${q(CB)}`), "1");
      chk("x", s.t, "mv_in", "control", "A's owner updates A's own row (the update path is live)", A, `update ${t} set ${s.updSet} where ${whA}`, "rows=1");
    }

    if (s.canIns && s.uq && !s.single) {
      const ups = (c, id, jb) => `${s.ins(c, id, jb, ctxOf(c === CA ? "a" : "b"))} on conflict (${s.uq}) do update set ${s.updSet}`;
      chk("x", s.t, "ups_b", "probe", "A's owner upserts onto the key B's row already holds", A, ups(CB, rid("b", s), jobOf("b")), "ERR 42501");
      chk("s", s.t, "ups_b", "readback", "B's row exists and was not changed", null, count(t, `${whB} and not (${s.updIs})`), "1");
      chk("x", s.t, "ups_b", "control", "the same upsert onto A's own key", A, ups(CA, rid("a", s), jobOf("a")), "rows=1");
    }

    if (s.job && s.canIns) {
      // Accepted by the policy (the row carries A's own company_id), so the question is whether it reaches B.
      chk("x", s.t, "ref_x", "probe", "A's owner inserts A's own row that names B's job by its sync id", A, s.ins(CA, cross, jobOf("b"), ctxOf("a")), "rows=1|ERR 42501");
      chk("s", s.t, "ref_x", "readback", "B's job is byte-for-byte what it was", null,
        `select (md5(to_jsonb(j)::text) = (select v from snap where k = 'jobs:row:b'))::text from public.jobs j where j.id = ${q(jobOf("b"))}`, "true");
      chk("x", s.t, "ref_x", "control", "the same insert naming A's own job", A, s.ins(CA, uuid("7", 100 + s.i), jobOf("a"), ctxOf("a")), "rows=1");
    }

    // ---- nothing in B changed, and the fingerprint can tell when something does
    chk("s", s.t, "b_unchanged", "readback", `every ${s.t} row B owns is unchanged by every attack above`, null,
      `select (pg_temp.dig(${L(s.t)}, ${q(CB)}) = (select v from snap where k = ${L(s.t + ":b")}))::text`, "true");
    const sensSql = s.single
      ? (s.t === "company_settings" ? `update ${t} set ${s.updSet} where company_id = ${q(CB)}` : `update ${t} set updated_at = now() + interval '1 second' where company_id = ${q(CB)}`)
      : s.ins(CB, sens, s.job ? uuid("7", 150) : jobOf("b"), { ...ctxOf("b"), member: U.BM2 });
    emit(`  ${sensSql};`);
    chk("s", s.t, "b_unchanged", "control", "an authorised change to B's rows does change the fingerprint", null,
      `select (pg_temp.dig(${L(s.t)}, ${q(CB)}) = (select v from snap where k = ${L(s.t + ":b")}))::text`, "false");
    if (s.t === "jobs") {
      // From here on, B's job is the reference the cross-parent probes compare against.
      emit(`  insert into snap values ('jobs:row:b', (select md5(to_jsonb(j)::text) from public.jobs j where j.id = ${q(jobOf("b"))}));`);
    }
  }

  // --------------------------------------- quote tokens, enumeration & use --
  {
    const A = U.AO;
    chk("q", "jobs", "quote_token", "probe", "A's owner looks a job up by B's quote token", A, count("public.jobs", `quote_token = ${q(TOK_B)}`), "0");
    chk("q", "jobs", "quote_token", "control", "A's owner looks a job up by A's own quote token", A, count("public.jobs", `quote_token = ${q(TOK_A)}`), "1");
    chk("q", "jobs", "quote_token_anon", "probe", "the anon key looks a job up by B's quote token", null, count("public.jobs", `quote_token = ${q(TOK_B)}`), "0|ERR 42501");
    chk("s", "jobs", "quote_token_anon", "control", "the token exists (read by the database owner)", null, count("public.jobs", `quote_token = ${q(TOK_B)}`), "1");
    chk("q", "jobs", "quote_token_stranger", "probe", "a signed-in stranger looks a job up by B's quote token", U.Z, count("public.jobs", `quote_token = ${q(TOK_B)}`), "0");
    chk("s", "jobs", "quote_token_stranger", "control", "the token exists (read by the database owner)", null, count("public.jobs", `quote_token = ${q(TOK_B)}`), "1");
    chk("q", "jobs", "quote_token_enum", "probe", "A's owner enumerates every quote token that is not A's (all real tenants included)", A, count("public.jobs", `quote_token is not null and company_id <> ${q(CA)}`), "0");
    chk("s", "jobs", "quote_token_enum", "info", "quote tokens that belong to real tenants and were out of reach", null, `select count(*)::text from public.jobs where quote_token is not null and company_id not in (${SYN})`, "info");
    chk("q", "jobs", "quote_token_enum", "control", "A's owner enumerates its own quote tokens", A, count("public.jobs", `quote_token is not null and company_id = ${q(CA)}`), ">=1");
    for (const [who, nm] of [[U.AO, "owner"], [U.AC, "crew"]]) {
      chk("q", "jobs_crew", `quote_token_crew_${nm}`, "probe", `A's ${nm} reads quote_token through the crew view`, who, `select quote_token::text from public.jobs_crew limit 1`, "ERR 42703");
      chk("q", "jobs_crew", `quote_token_crew_${nm}`, "control", `A's ${nm} reads the crew view`, who, `select count(*)::text from public.jobs_crew where company_id = ${q(CA)}`, ">=1");
    }
    chk("s", "jobs", "quote_token_default", "probe", "a job's quote_token is minted by gen_random_uuid() (122 random bits, not guessable)", null,
      `select (column_default like '%gen_random_uuid()%')::text from information_schema.columns where table_schema='public' and table_name='jobs' and column_name='quote_token'`, "true");
  }

  // ----------------------------------------------------- crew views (definer) --
  for (const v of CREW_VIEWS) {
    for (const [who, nm] of [[U.AO, "owner"], [U.AC, "crew"]]) {
      chk("q", v, `sel_b_${nm}`, "probe", `A's ${nm} reads B's rows through the view`, who, count(`public.${v}`, `company_id = ${q(CB)}`), "0");
      chk("q", v, `sel_b_${nm}`, "control", `A's ${nm} reads A's rows through the view`, who, count(`public.${v}`, `company_id = ${q(CA)}`), ">=1");
      chk("q", v, `sel_real_${nm}`, "probe", `A's ${nm} reads every row of the view that is not A's`, who, count(`public.${v}`, `company_id <> ${q(CA)}`), "0");
      chk("q", v, `sel_real_${nm}`, "control", `A's ${nm} reads A's own rows through the same view`, who, count(`public.${v}`, `company_id = ${q(CA)}`), ">=1");
    }
    for (const [who, pair, label] of [[null, "anon", "the anon key"], [U.Z, "nocompany_z", "a signed-in stranger"], [U.Y, "nocompany_y", "a signed-in person with no company"]]) {
      chk("q", v, pair, "probe", `${label} reads the view`, who, `select count(*)::text from public.${v}`, "0|ERR 42501");
      chk("q", v, pair, "control", "the view holds rows and answers (A's owner reads A's rows through it)", U.AO, count(`public.${v}`, `company_id = ${q(CA)}`), ">=1");
    }
  }
  for (const v of ["platform_clients", "admin_release_audience"]) {
    const idc = v === "platform_clients" ? "id" : "company_id";
    chk("q", v, "sel_b", "probe", "A's owner reads B's row through the operator view", U.AO, count(`public.${v}`, `${idc} = ${q(CB)}`), "0|ERR 42501");
    chk("q", v, "sel_real", "probe", "A's owner reads every operator-view row that is not A's", U.AO, count(`public.${v}`, `${idc} <> ${q(CA)}`), "0|ERR 42501");
    chk("q", v, "anon", "probe", "the anon key reads the operator view", null, `select count(*)::text from public.${v}`, "0|ERR 42501");
    chk("s", v, "anon", "info", "rows in the operator view (read by the database owner)", null, `select count(*)::text from public.${v}`, "info");
    chk("s", v, "sel_real", "info", "rows in the operator view (read by the database owner)", null, `select count(*)::text from public.${v}`, "info");
  }
  // These two are the operator's; they read admin columns no login role may select, so the operator reaches them with the server's key, never a tenant's.
  for (const v of ["platform_clients", "admin_release_audience"]) {
    chk("s", v, "sel_b", "control", "the view answers (read by the database owner)", null, `select count(*)::text from public.${v}`, "info");
  }
  chk("x", "platform_clients", "write", "probe", "A's owner updates B through the operator view", U.AO, `update public.platform_clients set admin_notes = 'A25 HACK' where id = ${q(CB)}`, "rows=0|ERR 42501");
  chk("s", "platform_clients", "write", "readback", "B's admin_notes is untouched", null, `select (admin_notes = '')::text from public.companies where id = ${q(CB)}`, "true");
  chk("s", "platform_clients", "write", "control", "the view exists and the database owner can read it", null, `select count(*)::text from public.platform_clients`, "info");

  // --------------------------------------------- tables with no grant at all --
  for (const t of NO_GRANT_TABLES) {
    for (const [who, nm] of [[U.AO, "owner"], [null, "anon"], [U.Z, "stranger"]]) {
      chk("q", t, `sel_${nm}`, "probe", `${nm === "owner" ? "A's owner" : nm === "anon" ? "the anon key" : "a signed-in stranger"} selects from the table`, who, `select count(*)::text from public.${t}`, "ERR 42501");
      chk("s", t, `sel_${nm}`, "control", "the table exists and the database owner can read it (so the refusal is the grant, not a typo)", null, `select count(*)::text from public.${t}`, "info");
    }
  }

  for (const t of OPERATOR_ONLY_TABLES) {
    for (const [who, nm] of [[U.AO, "owner"], [null, "anon"], [U.Z, "stranger"]]) {
      chk("q", t, `sel_${nm}`, "probe", `${nm === "owner" ? "A's owner" : nm === "anon" ? "the anon key" : "a signed-in stranger"} selects from the table`, who, `select count(*)::text from public.${t}`, "0|ERR 42501");
      chk("s", t, `sel_${nm}`, "control", "the table exists and the database owner can read it (real rows are counted, never read out)", null, `select count(*)::text from public.${t}`, "info");
    }
  }

  // --------------------------------------------------------------- companies --
  {
    const A = U.AO, T = "public.companies";
    chk("q", "companies", "sel_b", "probe", "A's owner reads B's company row (billing ids, admin notes, leads token)", A, count(T, `id = ${q(CB)}`), "0");
    chk("q", "companies", "sel_b", "control", "A's owner reads A's own company row", A, count(T, `id = ${q(CA)}`), "1");
    chk("q", "companies", "sel_real", "probe", "A's owner reads every company that is not A (real tenants included)", A, count(T, `id <> ${q(CA)}`), "0");
    chk("s", "companies", "sel_real", "info", "real tenant companies out of the attacker's reach", null, `select count(*)::text from public.companies where id not in (${SYN})`, "info");
    for (const [who, nm] of [[null, "anon"], [U.Z, "nocompany_z"], [U.Y, "nocompany_y"]]) {
      chk("q", "companies", nm, "probe", "reads every company", who, `select count(*)::text from ${T}`, "0|ERR 42501");
      chk("s", "companies", nm, "control", "companies exist", null, `select count(*)::text from ${T}`, ">=1");
    }
    // Even on its OWN row a tenant cannot select the operator's private notes or the payment-processor ids (column grants);
    // the leads token comes through my_leads_token(), owner and manager only.
    for (const col of ["admin_notes", "stripe_customer_id", "stripe_subscription_id", "stripe_account_id", "leads_token"]) {
      chk("q", "companies", "cols_own", "probe", `A's owner selects ${col} from A's own company row`, A, `select ${col}::text from ${T} where id = ${q(CA)}`, "ERR 42501");
      chk("q", "companies", "cols_own", "probe", `A's owner selects ${col} from B's company row`, A, `select ${col}::text from ${T} where id = ${q(CB)}`, "ERR 42501");
    }
    chk("q", "companies", "cols_own", "control", "A's owner selects an ordinary column (name) from A's own company row", A, `select (name like 'PROBE-A25-ATTACKER%')::text from ${T} where id = ${q(CA)}`, "true");
    emit(`  insert into snap values ('companies:b', (select md5(x::text) from public.companies x where id = ${q(CB)}));`);
    chk("x", "companies", "upd_b", "probe", "A's owner renames B's company", A, `update ${T} set name = 'A25 HACK' where id = ${q(CB)}`, "rows=0");
    chk("x", "companies", "upd_b", "probe", "A's owner suspends B's company", A, `update ${T} set suspended = true, suspended_reason = 'A25' where id = ${q(CB)}`, "rows=0");
    chk("x", "companies", "upd_b", "probe", "A's owner gives B's company a new leads token", A, `update ${T} set leads_token = gen_random_uuid() where id = ${q(CB)}`, "rows=0");
    chk("s", "companies", "upd_b", "readback", "B's company row is byte-for-byte unchanged", null, `select (md5(x::text) = (select v from snap where k='companies:b'))::text from public.companies x where id = ${q(CB)}`, "true");
    chk("x", "companies", "upd_b", "control", "A's owner renames A's own company", A, `update ${T} set name = 'PROBE-A25-ATTACKER TOUCH' where id = ${q(CA)}`, "rows=1");
    // A tenant must not be able to grant itself a plan or a trial: protect_billing_columns() reverts them silently.
    emit(`  insert into snap values ('billing:a', (select md5(row(subscription_plan,subscription_status,monthly_price,trial_ends_at,pass_card_fee,suspended,suspended_reason,grace_ends_at,subscription_ends_at)::text) from public.companies where id = ${q(CA)}));`);
    chk("x", "companies", "billing_self", "probe", "A's owner sets its OWN plan, status, price, trial end and suspension in the same update as a rename", A,
      `update ${T} set name = 'PROBE-A25-ATTACKER SELF', subscription_plan = 'enterprise', subscription_status = 'canceled', monthly_price = 0, trial_ends_at = '2099-01-01', pass_card_fee = true where id = ${q(CA)}`, "rows=1");
    chk("s", "companies", "billing_self", "readback", "the billing columns were reverted", null,
      `select (md5(row(subscription_plan,subscription_status,monthly_price,trial_ends_at,pass_card_fee,suspended,suspended_reason,grace_ends_at,subscription_ends_at)::text) = (select v from snap where k = 'billing:a'))::text from public.companies where id = ${q(CA)}`, "true");
    chk("s", "companies", "billing_self", "control", "the rename in that same statement landed", null, `select (name = 'PROBE-A25-ATTACKER SELF')::text from public.companies where id = ${q(CA)}`, "true");
    chk("x", "companies", "ins_b", "probe", "A's owner inserts a company", A, `insert into ${T}(id,name) values (${q(uuid("4", 91))},'A25 POISON')`, "ERR 42501");
    chk("x", "companies", "ins_b", "control", "the platform operator inserts a company (the door opens for one)", U.ADM, `insert into ${T}(id,name) values (${q(uuid("6", 91))},'A25 OPERATOR')`, "rows=1");
    chk("x", "companies", "del_b", "probe", "A's owner deletes B's company (which would cascade to every row B owns)", A, `delete from ${T} where id = ${q(CB)}`, "rows=0|ERR 42501");
    chk("s", "companies", "del_b", "readback", "B's company survived", null, count(T, `id = ${q(CB)}`), "1");
    chk("x", "companies", "del_b", "control", "A's owner deletes A's own company (closed to every tenant)", A, `delete from ${T} where id = ${q(CA)}`, "rows=0|ERR 42501");
  }

  // ---------------------------------------------------------------- profiles --
  {
    const A = U.AO, T = "public.profiles";
    chk("q", "profiles", "sel_b", "probe", "A's owner reads B's people", A, count(T, `company_id = ${q(CB)} or id = ${q(U.BO)}`), "0");
    chk("q", "profiles", "sel_b", "control", "A's owner reads A's people", A, count(T, `company_id = ${q(CA)}`), ">=5");
    chk("q", "profiles", "sel_real", "probe", "A's owner reads every profile that is not in A (real tenants included)", A, count(T, `company_id is not null and company_id <> ${q(CA)}`), "0");
    chk("q", "profiles", "sel_null", "probe", "A's owner reads other people's company-less profiles (removed members, fresh sign-ups)", A, count(T, `company_id is null and id <> ${q(A)}`), "0");
    chk("s", "profiles", "sel_null", "control", "company-less profiles exist (the synthetic one, plus real ones the attacker must not see)", null, count(T, "company_id is null"), ">=1");
    chk("s", "profiles", "sel_real", "info", "profiles that belong to real tenants and were out of reach", null, `select count(*)::text from public.profiles where company_id is not null and company_id not in (${SYN})`, "info");
    for (const [who, nm] of [[null, "anon"], [U.Z, "nocompany_z"]]) {
      chk("q", "profiles", nm, "probe", "reads every profile", who, `select count(*)::text from ${T}`, "0|ERR 42501");
      chk("s", "profiles", nm, "control", "profiles exist (read by the database owner)", null, `select count(*)::text from ${T}`, ">=1");
    }
    chk("q", "profiles", "nocompany_y", "probe", "a person with a company-less profile reads every OTHER profile", U.Y, count(T, `id <> ${q(U.Y)}`), "0");
    chk("q", "profiles", "nocompany_y", "control", "...and reads their own", U.Y, count(T, `id = ${q(U.Y)}`), "1");
    emit(`  insert into snap values ('profiles:b', (select md5(string_agg(md5(x::text),'' order by id)) from public.profiles x where company_id = ${q(CB)} or id in (${q(U.BX)})));`);
    chk("x", "profiles", "upd_b", "probe", "A's owner renames B's crew member", A, `update ${T} set full_name = 'A25 HACK' where id = ${q(U.BC)}`, "rows=0");
    chk("x", "profiles", "upd_b", "probe", "A's owner makes B's crew member an OWNER", A, `update ${T} set role = 'OWNER' where id = ${q(U.BC)}`, "rows=0");
    chk("x", "profiles", "upd_b", "probe", "A's owner evicts B's owner from B", A, `update ${T} set company_id = null where id = ${q(U.BO)}`, "rows=0");
    chk("x", "profiles", "steal", "probe", "A's owner pulls B's crew member into A", A, `update ${T} set company_id = ${q(CA)} where id = ${q(U.BC)}`, "rows=0");
    chk("x", "profiles", "steal", "probe", "A's owner brings B's removed member back into A", A, `update ${T} set company_id = ${q(CA)} where id = ${q(U.BX)}`, "rows=0");
    chk("x", "profiles", "steal", "control", "A's owner updates A's own crew member (the update path is live)", A, `update ${T} set full_name = 'A25 TOUCH' where id = ${q(U.AM2)}`, "rows=1");
    chk("s", "profiles", "upd_b", "readback", "B's people are byte-for-byte unchanged", null,
      `select (md5(string_agg(md5(x::text),'' order by id)) = (select v from snap where k='profiles:b'))::text from public.profiles x where company_id = ${q(CB)} or id in (${q(U.BX)})`, "true");
    chk("x", "profiles", "upd_b", "control", "A's owner renames A's own crew member", A, `update ${T} set full_name = 'A25 TOUCH' where id = ${q(U.AM1)}`, "rows=1");
    chk("x", "profiles", "push", "probe", "A's owner pushes A's crew member INTO company B", A, `update ${T} set company_id = ${q(CB)} where id = ${q(U.AM1)}`, "ERR 42501");
    chk("x", "profiles", "push", "probe", "A's owner moves A's OWN profile into company B", A, `update ${T} set company_id = ${q(CB)} where id = ${q(A)}`, "ERR 42501");
    chk("s", "profiles", "push", "readback", "A's people are still A's", null, count(T, `id in (${q(U.AM1)},${q(A)}) and company_id = ${q(CA)}`), "2");
    chk("x", "profiles", "push", "control", "A's owner renames A's own profile", A, `update ${T} set full_name = 'A25 SELF' where id = ${q(A)}`, "rows=1");
    // The route from a tenant to the platform: the operator flag.
    chk("x", "profiles", "admin_flag", "probe", "A's owner sets is_platform_admin on their OWN profile", A, `update ${T} set is_platform_admin = true where id = ${q(A)}`, "ERR P0001");
    chk("x", "profiles", "admin_flag", "probe", "A's owner sets is_platform_admin on a crew member", A, `update ${T} set is_platform_admin = true where id = ${q(U.AM1)}`, "ERR P0001");
    chk("s", "profiles", "admin_flag", "readback", "nobody in A is a platform admin", null, count(T, `company_id = ${q(CA)} and is_platform_admin`), "0");
    chk("q", "profiles", "admin_flag", "probe", "is_platform_admin() as A's owner", A, `select public.is_platform_admin()::text`, "false");
    chk("q", "profiles", "admin_flag", "control", "is_platform_admin() as the synthetic operator", U.ADM, `select public.is_platform_admin()::text`, "true");
    chk("x", "profiles", "ins_b", "probe", "A's owner creates a profile inside company B", A, `insert into ${T}(id,company_id,role) values (${q(uuid("1", 30))},${q(CB)},'OWNER')`, "ERR 42501");
    chk("x", "profiles", "ins_b", "control", "the same insert into A's own company (closed to every tenant: profiles come from the join RPCs)", A, `insert into ${T}(id,company_id,role) values (${q(uuid("1", 30))},${q(CA)},'OWNER')`, "ERR 42501");
    chk("s", "profiles", "ins_b", "readback", "no profile was created", null, count(T, `id = ${q(uuid("1", 30))}`), "0");
    chk("x", "profiles", "del_b", "probe", "A's owner deletes B's owner's profile", A, `delete from ${T} where id = ${q(U.BO)}`, "rows=0|ERR 42501");
    chk("s", "profiles", "del_b", "readback", "B's owner still exists", null, count(T, `id = ${q(U.BO)}`), "1");
    chk("x", "profiles", "del_b", "control", "A's owner deletes A's own crew member's profile (closed to every tenant)", A, `delete from ${T} where id = ${q(U.AM2)}`, "rows=0|ERR 42501");
    chk("s", "profiles", "del_b", "control", "...and it survived", null, count(T, `id = ${q(U.AM2)}`), "1");
  }

  // ---------------------------------------- per-user tables: tokens, prefs, error inbox --
  {
    const A = U.AO, B = U.BO;
    chk("q", "device_tokens", "sel_b", "probe", "A's owner reads B's push token", A, count("public.device_tokens", `user_id = ${q(B)}`), "0");
    chk("q", "device_tokens", "sel_real", "probe", "A's owner reads every push token that is not theirs (real devices included)", A, count("public.device_tokens", `user_id <> ${q(A)}`), "0");
    chk("s", "device_tokens", "sel_real", "info", "push tokens that belong to real devices and were out of reach", null, `select count(*)::text from public.device_tokens where user_id not in (${q(A)},${q(B)})`, "info");
    chk("x", "device_tokens", "ins_b", "probe", "A's owner registers a token row for B's user", A, `insert into public.device_tokens(token,user_id,company_id) values ('a25-poison-1',${q(B)},${q(CB)})`, "ERR 42501");
    chk("x", "device_tokens", "ins_b", "probe", "A's owner registers a token row for themselves inside company B", A, `insert into public.device_tokens(token,user_id,company_id) values ('a25-poison-2',${q(A)},${q(CB)})`, "ERR 42501");
    chk("x", "device_tokens", "ins_b", "control", "A's owner registers a token for themselves in A", A, `insert into public.device_tokens(token,user_id,company_id) values ('a25-token-a',${q(A)},${q(CA)})`, "rows=1");
    chk("q", "device_tokens", "sel_b", "control", "A's owner reads their own token", A, count("public.device_tokens", `user_id = ${q(A)}`), "1");
    chk("x", "device_tokens", "upd_b", "probe", "A's owner re-assigns B's push token to themselves", A, `update public.device_tokens set user_id = ${q(A)}, company_id = ${q(CA)} where token = 'a25-token-b'`, "rows=0");
    chk("s", "device_tokens", "upd_b", "readback", "B's token is still B's", null, count("public.device_tokens", `token = 'a25-token-b' and user_id = ${q(B)}`), "1");
    chk("x", "device_tokens", "upd_b", "control", "A's owner updates their own token row", A, `update public.device_tokens set platform = 'android' where token = 'a25-token-a'`, "rows=1");
    chk("x", "device_tokens", "del_b", "probe", "A's owner deletes B's push token", A, `delete from public.device_tokens where token = 'a25-token-b'`, "rows=0");
    chk("s", "device_tokens", "del_b", "readback", "B's token is still B's", null, count("public.device_tokens", `token = 'a25-token-b' and user_id = ${q(B)}`), "1");
    chk("x", "device_tokens", "del_b", "control", "A's owner deletes their own token (this table has an own-row delete policy)", A, `delete from public.device_tokens where token = 'a25-token-a'`, "rows=1");
    // The SECURITY DEFINER door: register_device_token upserts on the token alone.
    chk("x", "register_device_token", "hijack", "probe", "A's owner registers a token string that is already B's device", A, `select public.register_device_token('a25-token-b')`, "ERR P0001|ERR 42501");
    chk("s", "register_device_token", "hijack", "readback", "B's token still delivers to B", null, count("public.device_tokens", `token = 'a25-token-b' and user_id = ${q(B)} and company_id = ${q(CB)}`), "1");
    chk("x", "register_device_token", "hijack", "control", "A's owner registers a fresh token string of their own", A, `select public.register_device_token('a25-token-a2')`, "rows=1");

    chk("q", "notification_prefs", "sel_b", "probe", "A's owner reads B's notification preferences", A, count("public.notification_prefs", `user_id = ${q(B)}`), "0");
    chk("x", "notification_prefs", "ins_b", "probe", "A's owner writes a preferences row for B's user", A, `insert into public.notification_prefs(user_id) values (${q(B)})`, "ERR 42501");
    chk("x", "notification_prefs", "ins_b", "control", "A's owner writes their own preferences row", A, `insert into public.notification_prefs(user_id) values (${q(A)})`, "rows=1");
    chk("q", "notification_prefs", "sel_b", "control", "A's owner reads their own row", A, count("public.notification_prefs", `user_id = ${q(A)}`), "1");
    chk("x", "notification_prefs", "upd_b", "probe", "A's owner updates B's preferences", A, `update public.notification_prefs set muted_alerts = array['a25'] where user_id = ${q(B)}`, "rows=0");
    chk("s", "notification_prefs", "upd_b", "readback", "B's preferences are unchanged", null, count("public.notification_prefs", `user_id = ${q(B)} and not ('a25' = any (muted_alerts))`), "1");
    chk("x", "notification_prefs", "upd_b", "control", "A's owner updates their own preferences", A, `update public.notification_prefs set muted_alerts = array['a25'] where user_id = ${q(A)}`, "rows=1");

    // app_errors: the operator's crash inbox. Any signed-in caller may INSERT, and the row carries whatever company_id they name.
    chk("x", "app_errors", "ins_b", "probe", "A's owner files a crash report attributed to company B and B's owner", A,
      `insert into public.app_errors(company_id,reported_by,email,message) values (${q(CB)},${q(B)},'a25-bo@probe.invalid','A25 POISON')`, "ERR 42501|rows=1");
    chk("s", "app_errors", "ins_b", "readback", "no stored crash report is attributed to company B or to B's owner (refused, or stored under the caller's own identity)", null, count("public.app_errors", `message = 'A25 POISON' and (company_id = ${q(CB)} or reported_by = ${q(B)})`), "0");
    chk("x", "app_errors", "ins_b", "control", "A's owner files a crash report attributed to A", A,
      `insert into public.app_errors(company_id,reported_by,email,message) values (${q(CA)},${q(A)},'a25-ao@probe.invalid','A25 OWN')`, "rows=1");
    chk("q", "app_errors", "sel_b", "probe", "A's owner reads the crash inbox", A, `select count(*)::text from public.app_errors`, "0");
    chk("q", "app_errors", "sel_b", "control", "the platform operator reads the crash inbox", U.ADM, `select count(*)::text from public.app_errors`, ">=1");
    chk("x", "app_errors", "size", "info", "A's owner files one 200,000-character crash report (no size cap?)", A,
      `insert into public.app_errors(company_id,reported_by,message,stack) values (${q(CA)},${q(A)},'A25 SIZE',repeat('x',200000))`, "info");
    chk("x", "app_errors", "stranger", "info", "a signed-in stranger with no profile at all files a crash report", U.Z,
      `insert into public.app_errors(company_id,reported_by,message) values (null,${q(U.Z)},'A25 STRANGER')`, "info");
    chk("x", "app_errors", "upd_b", "probe", "A's owner marks crash reports seen", A, `update public.app_errors set seen = true where message = 'A25 fixture error'`, "rows=0");
    chk("s", "app_errors", "upd_b", "readback", "the fixture crash report is still unseen", null, count("public.app_errors", `message = 'A25 fixture error' and not seen`), "1");
    chk("x", "app_errors", "upd_b", "control", "the platform operator marks a crash report seen", U.ADM, `update public.app_errors set seen = true where message = 'A25 fixture error'`, "rows=1");
  }

  // ------------------------------------------------------------- storage --
  {
    const A = U.AO, T = "storage.objects";
    const pathA = `${CA}/${jobOf("a")}/a25/probe-a.txt`, pathB = `${CB}/${jobOf("b")}/a25/probe-b.txt`;
    chk("q", "storage.objects", "sel_b", "probe", "A's owner lists B's file", A, count(T, `bucket_id = 'job-files' and name = '${pathB}'`), "0");
    chk("q", "storage.objects", "sel_b", "control", "A's owner lists A's file", A, count(T, `bucket_id = 'job-files' and name = '${pathA}'`), "1");
    chk("q", "storage.objects", "sel_real", "probe", "A's owner lists every job file outside A's folder (real signatures and photos included)", A, count(T, `bucket_id = 'job-files' and (storage.foldername(name))[1] <> '${CA}'`), "0");
    chk("s", "storage.objects", "sel_real", "info", "job files that belong to real tenants and were out of reach", null, `select count(*)::text from storage.objects where bucket_id = 'job-files' and (storage.foldername(name))[1] not in ('${CA}','${CB}')`, "info");
    chk("q", "storage.objects", "anon", "probe", "the anon key lists job files", null, count(T, `bucket_id = 'job-files'`), "0|ERR 42501");
    chk("s", "storage.objects", "anon", "control", "job files exist (read by the database owner)", null, count(T, `bucket_id = 'job-files'`), ">=1");
    chk("q", "storage.objects", "nocompany_z", "probe", "a signed-in stranger lists job files", U.Z, count(T, `bucket_id = 'job-files'`), "0");
    chk("s", "storage.objects", "nocompany_z", "control", "job files exist (read by the database owner)", null, count(T, `bucket_id = 'job-files'`), ">=1");
    chk("x", "storage.objects", "ins_b", "probe", "A's owner uploads into B's folder", A, `insert into storage.objects(bucket_id,name,owner) values ('job-files','${CB}/${jobOf("b")}/a25/poison.txt',${q(A)})`, "ERR 42501");
    chk("x", "storage.objects", "ins_b", "control", "A's owner uploads into A's folder", A, `insert into storage.objects(bucket_id,name,owner) values ('job-files','${CA}/${jobOf("a")}/a25/own.txt',${q(A)})`, "rows=1");
    chk("s", "storage.objects", "ins_b", "readback", "nothing landed in B's folder", null, count(T, `name = '${CB}/${jobOf("b")}/a25/poison.txt'`), "0");
    chk("x", "storage.objects", "upd_b", "probe", "A's owner rewrites B's file record", A, `update storage.objects set metadata = '{"size":9}' where bucket_id = 'job-files' and name = '${pathB}'`, "rows=0");
    chk("s", "storage.objects", "upd_b", "readback", "B's file record is unchanged", null, count(T, `name = '${pathB}' and metadata = '{"size":1}'::jsonb`), "1");
    chk("x", "storage.objects", "upd_b", "control", "A's owner rewrites A's file record", A, `update storage.objects set metadata = '{"size":2}' where bucket_id = 'job-files' and name = '${pathA}'`, "rows=1");
    chk("x", "storage.objects", "del_b", "probe", "A's owner deletes B's file record", A, `delete from storage.objects where bucket_id = 'job-files' and name = '${pathB}'`, "rows=0|ERR 42501");
    chk("s", "storage.objects", "del_b", "readback", "B's file survived", null, count(T, `name = '${pathB}'`), "1");
    chk("x", "storage.objects", "del_b", "control", "A's owner deletes A's file record (Storage forbids direct deletes: it must be the API)", A, `delete from storage.objects where bucket_id = 'job-files' and name = '${pathA}'`, "ERR 42501|ERR P0001");
  }

  rpcBlock({ emit, chk, count, rid, co, jobOf, byName, ctxOf });

  const sql = `${PRELUDE}\ndo $body$\nbegin\n${body.join("\n")}\nend $body$;\n${EPILOGUE}`;
  return { sql, checks };
}

// ======================================================== the RPC doors ====
/**
 * Every SECURITY DEFINER function a tenant can call is a way past row-level
 * security, because it runs as the database owner: the company boundary inside it
 * is whatever its author wrote. This calls the ones that take an id from the
 * caller with the OTHER company's ids, then reads back (as the owner of the
 * database) whether anything changed. Each has a control: the same call with A's
 * own id, which must work.
 */
function rpcBlock({ emit, chk, count, rid, byName }) {
  const A = U.AO, AC = U.AC;
  const jA2 = uuid("7", 1), jB2 = uuid("7", 2), jA3 = uuid("7", 3), jB3 = uuid("7", 4);
  const tA = uuid("7", 10), tB = uuid("7", 11), fdA = uuid("7", 12), fdB = uuid("7", 13), flA = uuid("7", 14), flB = uuid("7", 15);
  const shA = uuid("7", 16), shAc = uuid("7", 17), shAd = uuid("7", 18), shB = uuid("7", 19);
  const tmA = uuid("7", 20), tmB = uuid("7", 21), pmA = uuid("7", 22), pmB = uuid("7", 23);
  const eAC = EMP.a, eBC = EMP.b;
  const lineX = uuid("5", 60), lineY = uuid("5", 61), coX = uuid("5", 62), coY = uuid("5", 63);

  emit(`  execute 'reset role'; perform set_config('request.jwt.claims','',true);`);
  emit(`  -- ---- RPC fixtures: two jobs per company for the id-taking doors, drifted totals, shifts, templates, mail links`);
  const job = (id, c, nm) => `(${q(id)},${q(c)},${q(id)},${L(nm)},'1 Probe Way','555-0100','a25@probe.invalid','ACCEPTED',5000,gen_random_uuid(),false,'','','','','',4,10,'2026-01-01 00:00:00+00',now(),500,0)`;
  emit(`  insert into public.jobs(id,company_id,sync_id,customer_name,address,phone,email,status,contract_total,quote_token,is_test_fixture,notes,hoa_name,permit_number,priced_by,pricing_engine_version,estimated_duration_hours,waste_percent,updated_at,quote_approved_at,deposit_amount,amount_paid) values
    ${job(jA2, CA, "A25 RPC A2")}, ${job(jB2, CB, "A25 RPC B2")}, ${job(jA3, CA, "A25 RPC A3")}, ${job(jB3, CB, "A25 RPC B3")};`);
  emit(`  insert into public.payment_records(id,sync_id,company_id,job_sync_id,amount,method,received_at,note,recorded_by) values
    (${q(pmA)},${q(pmA)},${q(CA)},${q(jA3)},100,'check',now(),'','A25'), (${q(pmB)},${q(pmB)},${q(CB)},${q(jB3)},100,'check',now(),'','A25');`);
  emit(`  update public.jobs set amount_paid = 0 where sync_id in (${q(jA3)},${q(jB3)});   -- drift both totals, then see whose the door repairs`);
  const shift = (id, c, jb, emp) => `(${q(id)},${q(c)},${q(id)},${q(jb)},${q(emp)},now()-interval '9 hours',now()-interval '1 hour',21,'',now())`;
  emit(`  insert into public.time_entries(id,company_id,sync_id,job_sync_id,employee_sync_id,started_at,ended_at,hourly_rate,notes,updated_at) values
    ${shift(shA, CA, jA2, eAC)}, ${shift(shAc, CA, jA2, eAC)}, ${shift(shAd, CA, jA2, eAC)}, ${shift(shB, CB, jB2, eBC)};`);
  const tmpl = (id, c) => `(${q(id)},${q(id)},${q(c)},'A25 template','VINYL',6,6,6)`;
  emit(`  insert into public.build_templates(id,sync_id,company_id,name,fence_type,panel_width_ft,panel_height_ft,post_spacing_ft) values ${tmpl(tA, CA)}, ${tmpl(tB, CB)};`);
  emit(`  insert into public.attention_findings(id,company_id,job_sync_id,detector,message,fp) values (${q(fdA)},${q(CA)},${q(jA2)},'a25','A25','fp-a'),(${q(fdB)},${q(CB)},${q(jB2)},'a25','A25','fp-b');`);
  emit(`  insert into public.automation_flags(id,company_id,job_sync_id,rule_key,message) values (${q(flA)},${q(CA)},${q(jA2)},'a25_rule','A25'),(${q(flB)},${q(CB)},${q(jB2)},'a25_rule','A25');`);
  emit(`  insert into public.mail_threads(id,company_id,subject) values (${q(tmA)},${q(CA)},'A25 rpc thread'),(${q(tmB)},${q(CB)},'A25 rpc thread');`);
  emit(`  insert into public.mail_thread_jobs(thread_id,company_id,job_sync_id) values (${q(tmB)},${q(CB)},${q(jB2)}),(${q(tmA)},${q(CA)},${q(jA3)});`);
  emit(`  insert into public.automation_rules(company_id,rule_key,enabled) values (${q(CA)},'approved_no_deposit_flag',true),(${q(CB)},'approved_no_deposit_flag',true);`);
  emit(`  insert into public.device_keys(company_id,code) values (${q(CA)},'A25AKEY1'),(${q(CB)},'A25BKEY1');`);
  emit(`  insert into snap values ('rpc:b:jobs', (select md5(string_agg(md5(j::text),'' order by j.id)) from public.jobs j where j.id in (${q(jB2)},${q(jB3)})));`);

  // ---- doors that take a COMPANY id
  chk("x", "recompute_job_totals", "cross_write", "probe", "A's owner recomputes the totals of B's job by naming B's company id", A, `select public.recompute_job_totals(${q(CB)}, ${q(jB3)})`, "rows=1|ERR 42501|ERR P0001");
  chk("s", "recompute_job_totals", "cross_write", "readback", "B's job still carries the amount_paid it had (0): the call changed nothing of B's", null,
    `select amount_paid::text from public.jobs where sync_id = ${q(jB3)}`, "0");
  chk("s", "recompute_job_totals", "cross_write", "info", "entries in B's audit log for that job that name A's owner as the person who changed it", null,
    count("public.audit_log", `company_id = ${q(CB)} and record_id = '${jB3}' and field = 'amount_paid' and actor = ${q(A)}`), "info");
  chk("x", "recompute_job_totals", "cross_write", "info", "A's owner calls the function directly on A's own job (the door itself)", A, `select public.recompute_job_totals(${q(CA)}, ${q(jA3)})`, "info");
  // The control is the door the product actually uses: recording a payment fires the trigger that re-totals the job from its ledger.
  chk("x", "recompute_job_totals", "cross_write", "control", "A's owner records a 50 payment on A's own job (100 already on its ledger)", A,
    `insert into public.payment_records(id,sync_id,company_id,job_sync_id,amount,method,received_at,note,recorded_by) values (${q(uuid("6", 70))},${q(uuid("6", 70))},${q(CA)},${q(jA3)},50,'check',now(),'','A25')`, "rows=1");
  chk("s", "recompute_job_totals", "cross_write", "control", "...and A's job now carries the whole ledger (150): the re-total machinery works for its own tenant", null, `select amount_paid::text from public.jobs where sync_id = ${q(jA3)}`, "150");

  chk("q", "company_allowed", "cross_read", "probe", "A's owner asks whether company B is in good standing (its billing state)", A, `select public.company_allowed(${q(CB)})::text`, "NULL|ERR 42501|ERR P0001");
  chk("q", "company_allowed", "cross_read", "control", "A's owner asks about A", A, `select public.company_allowed(${q(CA)})::text`, "true");

  chk("x", "release_for_payment", "cross_write", "probe", "A's owner lifts a suspension on company B", A, `select public.release_for_payment(${q(CB)})`, "ERR P0001");
  chk("x", "release_for_payment", "cross_write", "control", "the platform operator calls the same door on a synthetic company", U.ADM, `select public.release_for_payment(${q(CY)})`, "rows=1");

  // ---- the operator's doors: every one must refuse a tenant, and open for the operator
  const admin = [
    `public.admin_suspend(${q(CB)}, 'A25', false)`, `public.admin_unsuspend(${q(CB)})`, `public.admin_extend_trial(${q(CB)}, 30)`,
    `public.admin_grant_access(${q(CB)}, 'A25')`, `public.admin_start_trial(${q(CB)}, 30)`, `public.admin_mark_invited(${q(CB)}, 'a25@probe.invalid')`,
    `public.admin_promote_release(${q(uuid("4", 92))})`, `public.admin_demote_release(${q(uuid("4", 93))})`, `public.admin_create_company('A25 POISON', 'a25@probe.invalid')`,
  ];
  for (const call of admin) chk("x", "operator_functions", "admin_door", "probe", `A's owner calls ${call.split("(")[0].replace("public.", "")}()`, A, `select * from ${call}`, "ERR P0001");
  chk("q", "operator_functions", "admin_door", "probe", "A's owner lists every company on the platform", A, `select count(*)::text from public.admin_companies()`, "0");
  chk("q", "operator_functions", "admin_door", "control", "the platform operator lists every company (synthetic operator; counted, never read)", U.ADM, `select count(*)::text from public.admin_companies()`, ">=3");
  chk("q", "operator_functions", "admin_door", "probe", "A's owner reads the operator's crash summary", A, `select count(*)::text from public.admin_error_summary(30)`, "0");
  chk("s", "operator_functions", "admin_door", "readback", "B's company row is byte-for-byte what it was after every operator call above", null,
    `select (md5(x::text) = (select v from snap where k='companies:b'))::text from public.companies x where id = ${q(CB)}`, "true");
  chk("s", "operator_functions", "admin_door", "readback", "no company named A25 POISON was created", null, count("public.companies", `name = 'A25 POISON'`), "0");
  chk("x", "operator_functions", "admin_door", "control", "the platform operator extends a synthetic company's trial", U.ADM, `select public.admin_extend_trial(${q(CY)}, 5)`, "rows=1");
  chk("x", "operator_functions", "admin_door", "control", "the platform operator suspends a synthetic company", U.ADM, `select public.admin_suspend(${q(CY)}, 'A25', false)`, "rows=1");
  chk("s", "operator_functions", "admin_door", "control", "...and it took effect", null, `select suspended::text from public.companies where id = ${q(CY)}`, "true");

  // ---- doors that take a PERSON id
  chk("q", "removed_people", "cross_read", "probe", "A's owner lists people removed from B", A, `select count(*)::text from public.removed_people() where id = ${q(U.BX)}`, "0");
  chk("q", "removed_people", "cross_read", "control", "A's owner lists people removed from A", A, `select count(*)::text from public.removed_people() where id = ${q(U.AX)}`, "1");
  chk("x", "set_member_role", "cross_write", "probe", "A's owner sets the role of B's crew member", A, `select public.set_member_role(${q(U.BM2)}, 'MANAGER')`, "ERR P0001");
  chk("s", "set_member_role", "cross_write", "readback", "B's member is still CREW", null, `select role::text from public.profiles where id = ${q(U.BM2)}`, "CREW");
  chk("x", "set_member_role", "cross_write", "control", "A's owner sets the role of A's own member", A, `select public.set_member_role(${q(U.AM1)}, 'MANAGER')`, "rows=1");
  chk("s", "set_member_role", "cross_write", "control", "...and it took effect", null, `select role::text from public.profiles where id = ${q(U.AM1)}`, "MANAGER");
  chk("x", "release_seat", "cross_write", "probe", "A's owner removes B's crew member from B", A, `select public.release_seat(${q(U.BM2)})`, "ERR P0001");
  chk("s", "release_seat", "cross_write", "readback", "B's member is still in B", null, `select (company_id = ${q(CB)})::text from public.profiles where id = ${q(U.BM2)}`, "true");
  chk("x", "release_seat", "cross_write", "control", "A's owner removes A's own member", A, `select public.release_seat(${q(U.AM2)})`, "rows=1");
  chk("s", "release_seat", "cross_write", "control", "...and it took effect", null, `select (company_id is null and removed_from_company_id = ${q(CA)})::text from public.profiles where id = ${q(U.AM2)}`, "true");
  chk("x", "allow_rejoin", "cross_write", "probe", "A's owner lets B's removed member back in", A, `select public.allow_rejoin(${q(U.BX)})`, "rows=1|ERR P0001");
  chk("s", "allow_rejoin", "cross_write", "readback", "B's removed member is still blocked from B", null, `select (removed_from_company_id = ${q(CB)})::text from public.profiles where id = ${q(U.BX)}`, "true");
  chk("x", "allow_rejoin", "cross_write", "control", "A's owner lets A's removed member back in", A, `select public.allow_rejoin(${q(U.AX)})`, "rows=1");
  chk("s", "allow_rejoin", "cross_write", "control", "...and it took effect", null, `select (removed_from_company_id is null)::text from public.profiles where id = ${q(U.AX)}`, "true");
  chk("q", "company_members", "cross_read", "probe", "A's owner lists B's members", A, `select count(*)::text from public.company_members() where id in (${q(U.BO)},${q(U.BC)},${q(U.BM)})`, "0");
  chk("q", "company_members", "cross_read", "control", "A's owner lists A's members", A, `select count(*)::text from public.company_members() where id = ${q(A)}`, "1");
  chk("q", "crew_roster", "cross_read", "probe", "A's owner lists B's crew records", A, `select count(*)::text from public.crew_roster() where sync_id = ${q(eBC)}`, "0");
  chk("q", "crew_roster", "cross_read", "control", "A's owner lists A's crew records", A, `select count(*)::text from public.crew_roster() where sync_id = ${q(eAC)}`, "1");
  chk("q", "list_device_keys", "cross_read", "probe", "A's owner lists B's device keys", A, `select count(*)::text from public.list_device_keys() where code = 'A25BKEY1'`, "0");
  chk("q", "list_device_keys", "cross_read", "control", "A's owner lists A's device keys", A, `select count(*)::text from public.list_device_keys() where code = 'A25AKEY1'`, "1");
  chk("q", "my_leads_token", "cross_read", "probe", "A's owner's leads token is B's", A, `select (public.my_leads_token() = ${q(uuid("f", 4))})::text`, "false");
  chk("q", "my_leads_token", "cross_read", "control", "A's owner's leads token is A's", A, `select (public.my_leads_token() = ${q(uuid("f", 3))})::text`, "true");

  // ---- company email
  chk("x", "set_mail_access", "cross_write", "probe", "A's owner switches company email off for B's manager", A, `select public.set_mail_access(${q(U.BM)}, false)`, "ERR P0002");
  chk("s", "set_mail_access", "cross_write", "readback", "B's manager still has company email", null, `select allowed::text from public.mail_access where company_id = ${q(CB)} and profile_id = ${q(U.BM)}`, "true");
  chk("x", "set_mail_access", "cross_write", "control", "A's owner switches company email off for A's own manager", A, `select public.set_mail_access(${q(U.AMG)}, false)`, "rows=1");
  chk("s", "set_mail_access", "cross_write", "control", "...and it took effect", null, `select allowed::text from public.mail_access where company_id = ${q(CA)} and profile_id = ${q(U.AMG)}`, "false");
  chk("q", "mail_link_thread", "cross_write", "probe", "A's owner links B's email thread to A's job", A, `select public.mail_link_thread(${q(tmB)}, ${q(jA2)})::text`, "ERR P0002");
  chk("q", "mail_link_thread", "cross_write", "probe", "A's owner links A's email thread to B's job", A, `select public.mail_link_thread(${q(tmA)}, ${q(jB2)})::text`, "ERR P0002");
  chk("s", "mail_link_thread", "cross_write", "readback", "no link now joins A's company to B's thread or job", null,
    count("public.mail_thread_jobs", `company_id = ${q(CA)} and (thread_id = ${q(tmB)} or job_sync_id = ${q(jB2)})`), "0");
  chk("q", "mail_link_thread", "cross_write", "control", "A's owner links A's thread to A's job", A, `select public.mail_link_thread(${q(tmA)}, ${q(jA2)})::text`, "true");
  chk("q", "mail_unlink_thread", "cross_write", "probe", "A's owner unlinks B's thread from B's job", A, `select public.mail_unlink_thread(${q(tmB)}, ${q(jB2)})::text`, "false");
  chk("s", "mail_unlink_thread", "cross_write", "readback", "B's link survived", null, count("public.mail_thread_jobs", `thread_id = ${q(tmB)} and job_sync_id = ${q(jB2)}`), "1");
  chk("q", "mail_unlink_thread", "cross_write", "control", "A's owner unlinks A's own thread from A's job", A, `select public.mail_unlink_thread(${q(tmA)}, ${q(jA3)})::text`, "true");

  // ---- build templates and runs
  chk("q", "create_run_from_template", "cross_write", "probe", "A's owner builds a run on B's job", A, `select public.create_run_from_template(${q(jB2)}, ${q(tA)})::text`, "ERR P0001");
  chk("q", "create_run_from_template", "cross_write", "probe", "A's owner builds a run from B's template", A, `select public.create_run_from_template(${q(jA2)}, ${q(tB)})::text`, "ERR P0001");
  chk("s", "create_run_from_template", "cross_write", "readback", "B's job has no run", null, count("public.fence_runs", `job_sync_id = ${q(jB2)}`), "0");
  chk("q", "create_run_from_template", "cross_write", "control", "A's owner builds a run on A's job from A's template (on a job of its own: a new run on an approved job withdraws its approval, which the automation control below reads)", A, `select (public.create_run_from_template(${q(jA3)}, ${q(tA)}) is not null)::text`, "true");
  chk("q", "retire_build_template", "cross_write", "probe", "A's owner retires B's template", A, `select public.retire_build_template(${q(tB)})::text`, "false");
  chk("s", "retire_build_template", "cross_write", "readback", "B's template is still live", null, `select (deleted_at is null)::text from public.build_templates where company_id = ${q(CB)} and sync_id = ${q(tB)}`, "true");
  chk("q", "retire_build_template", "cross_write", "control", "A's owner retires A's own template", A, `select public.retire_build_template(${q(tA)})::text`, "true");
  chk("q", "save_build_template", "cross_write", "probe", "A's owner saves a template under B's sync id", A, `select (public.save_build_template(jsonb_build_object('sync_id', ${q(tB)}, 'name', 'A25 HACK', 'fence_type', 'VINYL')) is not null)::text`, "info");
  chk("s", "save_build_template", "cross_write", "readback", "B's template kept its name", null, `select (name = 'A25 template')::text from public.build_templates where company_id = ${q(CB)} and sync_id = ${q(tB)}`, "true");
  chk("q", "save_build_template", "cross_write", "control", "A's owner saves A's own template", A, `select (public.save_build_template(jsonb_build_object('sync_id', ${q(tA)}, 'name', 'A25 RENAMED', 'fence_type', 'VINYL')) is not null)::text`, "true");
  chk("s", "save_build_template", "cross_write", "control", "...and it took effect", null, `select (name = 'A25 RENAMED')::text from public.build_templates where company_id = ${q(CA)} and sync_id = ${q(tA)}`, "true");

  // ---- automation, stages, findings, flags
  chk("s", "run_automation_rule", "cross_write", "info", "the state of A's job the automation reads", null,
    `select row(quote_approved_at is not null, deposit_amount, amount_paid, status, reapproval_required_at is not null)::text from public.jobs where sync_id = ${q(jA2)}`, "info");
  chk("q", "run_automation_rule", "cross_write", "probe", "A's owner fires an automation on B's job", A, `select public.run_automation_rule('approved_no_deposit_flag', '${jB2}')`, "job not found");
  chk("s", "run_automation_rule", "cross_write", "readback", "B's job has no flag and no run", null, `select ((select count(*) from public.automation_flags where job_sync_id = ${q(jB2)} and rule_key = 'approved_no_deposit_flag') + (select count(*) from public.automation_runs where job_sync_id = ${q(jB2)} and rule_key = 'approved_no_deposit_flag'))::text`, "0");
  chk("q", "run_automation_rule", "cross_write", "control", "A's owner fires the same automation on A's job", A, `select public.run_automation_rule('approved_no_deposit_flag', '${jA2}')`, "done: Flag raised: approved with no deposit.");
  chk("x", "set_production_stage", "cross_write", "probe", "A's owner moves B's job to a build stage", A, `select public.set_production_stage('${jB2}', 'DIG')`, "ERR 23503");
  chk("s", "set_production_stage", "cross_write", "readback", "B's job has no stage", null, `select (production_stage is null)::text from public.jobs where sync_id = ${q(jB2)}`, "true");
  chk("q", "set_production_stage", "cross_write", "control", "A's owner moves A's own job", A, `select public.set_production_stage('${jA2}', 'DIG')::text`, "true");
  chk("x", "clear_attention_finding", "cross_write", "probe", "A's owner clears B's attention finding", A, `select public.clear_attention_finding(${q(fdB)})`, "rows=1|ERR P0001");
  chk("s", "clear_attention_finding", "cross_write", "readback", "B's finding is still open", null, `select (cleared_at is null)::text from public.attention_findings where id = ${q(fdB)}`, "true");
  chk("x", "clear_attention_finding", "cross_write", "control", "A's owner clears A's own finding", A, `select public.clear_attention_finding(${q(fdA)})`, "rows=1");
  chk("s", "clear_attention_finding", "cross_write", "control", "...and it took effect", null, `select (cleared_at is not null)::text from public.attention_findings where id = ${q(fdA)}`, "true");
  chk("x", "clear_automation_flag", "cross_write", "probe", "A's owner clears B's automation flag", A, `select public.clear_automation_flag(${q(flB)})`, "rows=1|ERR P0001");
  chk("s", "clear_automation_flag", "cross_write", "readback", "B's flag is still open", null, `select (cleared_at is null)::text from public.automation_flags where id = ${q(flB)}`, "true");
  chk("x", "clear_automation_flag", "cross_write", "control", "A's owner clears A's own flag", A, `select public.clear_automation_flag(${q(flA)})`, "rows=1");
  chk("s", "clear_automation_flag", "cross_write", "control", "...and it took effect", null, `select (cleared_at is not null)::text from public.automation_flags where id = ${q(flA)}`, "true");

  // ---- payroll: the shift doors pin the company inside the function
  chk("q", "approve_time_entry", "cross_write", "probe", "A's owner signs off a shift on B's payroll", A, `select public.approve_time_entry('${shB}', true, '')->>'outcome'`, "not_found");
  chk("s", "approve_time_entry", "cross_write", "readback", "B's shift is not approved", null, `select (approved_at is null)::text from public.time_entries where id = ${q(shB)}`, "true");
  chk("q", "approve_time_entry", "cross_write", "control", "A's owner signs off a shift on A's own payroll", A, `select public.approve_time_entry('${shA}', true, '')->>'outcome'`, "approved");
  chk("q", "correct_time_entry", "cross_write", "probe", "A's owner corrects the hours of a shift on B's payroll", A, `select public.correct_time_entry('${shB}', now() - interval '10 hours', now() - interval '2 hours', 'A25 reason')->>'outcome'`, "not_found");
  chk("s", "correct_time_entry", "cross_write", "readback", "B's shift hours are untouched", null, `select (corrected_at is null and original_started_at is null)::text from public.time_entries where id = ${q(shB)}`, "true");
  chk("q", "correct_time_entry", "cross_write", "control", "A's owner corrects the hours of a shift on A's own payroll", A, `select public.correct_time_entry('${shAc}', now() - interval '10 hours', now() - interval '2 hours', 'A25 reason')->>'outcome'`, "corrected");
  chk("q", "dispute_my_shift", "cross_write", "probe", "A's crew member disputes a shift on B's payroll", AC, `select public.dispute_my_shift('${shB}', 'A25 note')::text`, "false");
  chk("s", "dispute_my_shift", "cross_write", "readback", "B's shift carries no dispute", null, `select (correction_disputed_at is null)::text from public.time_entries where id = ${q(shB)}`, "true");
  chk("q", "dispute_my_shift", "cross_write", "control", "A's crew member disputes their own shift", AC, `select public.dispute_my_shift('${shAd}', 'A25 note')::text`, "true");
  chk("q", "acknowledge_my_shift", "cross_write", "probe", "A's crew member acknowledges a shift on B's payroll", AC, `select public.acknowledge_my_shift('${shB}')::text`, "false");
  chk("s", "acknowledge_my_shift", "cross_write", "readback", "B's shift is not marked seen", null, `select (correction_seen_at is null)::text from public.time_entries where id = ${q(shB)}`, "true");
  chk("q", "acknowledge_my_shift", "cross_write", "control", "A's crew member acknowledges their own shift", AC, `select public.acknowledge_my_shift('${shAd}')::text`, "true");
  chk("q", "my_shift_answer", "cross_read", "probe", "A's crew member reads the answer on a shift on B's payroll", AC, `select public.my_shift_answer('${shB}')::text`, "NULL");
  chk("q", "my_shift_answer", "cross_read", "control", "A's crew member reads the answer on their own shift", AC, `select public.my_shift_answer('${shAd}')->>'answer'`, "disputed");
  chk("q", "per_foot_crew_count", "cross_read", "probe", "A's owner counts the per-foot crew on B's job", A, `select public.per_foot_crew_count(${q(jB2)})::text`, "NULL");
  chk("q", "per_foot_crew_count", "cross_read", "control", "A's owner counts the per-foot crew on A's job", A, `select public.per_foot_crew_count(${q(jA2)})::text`, ">=0");

  // ---- the money reports
  chk("q", "job_costing", "cross_read", "probe", "A's owner's job-costing report lists B's job", A, `select count(*)::text from public.job_costing() where job_sync_id = '${jB2}'`, "0");
  chk("q", "job_costing", "cross_read", "control", "A's owner's job-costing report lists A's job", A, `select count(*)::text from public.job_costing() where job_sync_id = '${jA2}'`, "1");
  chk("q", "job_costing", "cross_read", "probe", "A's owner's job-costing report lists any job that is not A's (real tenants included)", A, `select count(*)::text from public.job_costing() jc where not exists (select 1 from public.jobs j where j.sync_id::text = jc.job_sync_id and j.company_id = ${q(CA)})`, "0");
  chk("q", "ar_aging", "cross_read", "probe", "A's owner's receivables report lists B's job", A, `select count(*)::text from public.ar_aging() where job_sync_id = '${jB2}'`, "0");
  chk("q", "ar_aging", "cross_read", "control", "A's owner's receivables report lists A's job", A, `select count(*)::text from public.ar_aging() where job_sync_id = '${jA2}'`, "1");
  chk("q", "ar_aging", "cross_read", "probe", "A's owner's receivables report lists any job that is not A's (real tenants included)", A, `select count(*)::text from public.ar_aging() ag where not exists (select 1 from public.jobs j where j.sync_id::text = ag.job_sync_id and j.company_id = ${q(CA)})`, "0");

  // ---- the crew write doors: SECURITY DEFINER, so the company pin is inside them
  chk("q", "crew_save_job", "cross_write", "probe", "A's owner writes a note onto B's job through the crew door", A, `select public.crew_save_job(jsonb_build_object('sync_id', ${q(jB2)}, 'notes', 'A25 HACK'))::text`, "false");
  chk("s", "crew_save_job", "cross_write", "readback", "B's job has no note", null, `select (notes = '')::text from public.jobs where sync_id = ${q(jB2)}`, "true");
  chk("q", "crew_save_job", "cross_write", "control", "A's owner writes a note onto A's job through the same door", A, `select public.crew_save_job(jsonb_build_object('sync_id', ${q(jA2)}, 'notes', 'A25 NOTE'))::text`, "true");
  chk("s", "crew_save_job", "cross_write", "control", "...and it took effect", null, `select (notes = 'A25 NOTE')::text from public.jobs where sync_id = ${q(jA2)}`, "true");
  chk("q", "crew_push_line_items", "cross_write", "probe", "A's owner pushes an estimate line onto B's job", A, `select public.crew_push_line_items(jsonb_build_array(jsonb_build_object('sync_id', ${q(lineX)}, 'job_sync_id', ${q(jB2)}, 'description', 'A25 HACK', 'quantity', 1)))::text`, "0");
  chk("s", "crew_push_line_items", "cross_write", "readback", "no line landed on B's job", null, count("public.estimate_line_items", `job_sync_id = ${q(jB2)}`), "0");
  chk("q", "crew_push_line_items", "cross_write", "control", "A's owner pushes an estimate line onto A's job", A, `select public.crew_push_line_items(jsonb_build_array(jsonb_build_object('sync_id', ${q(lineY)}, 'job_sync_id', ${q(jA2)}, 'description', 'A25 LINE', 'quantity', 1)))::text`, "1");
  chk("q", "crew_push_change_orders", "cross_write", "probe", "A's owner pushes a change order onto B's job, naming B's company", A, `select public.crew_push_change_orders(jsonb_build_array(jsonb_build_object('sync_id', ${q(coX)}, 'job_sync_id', ${q(jB2)}, 'company_id', ${q(CB)}, 'description', 'A25 HACK')))->>'inserted'`, "0");
  chk("q", "crew_push_change_orders", "cross_write", "probe", "A's owner pushes a change order onto B's job, naming their own company", A, `select public.crew_push_change_orders(jsonb_build_array(jsonb_build_object('sync_id', ${q(coX)}, 'job_sync_id', ${q(jB2)}, 'description', 'A25 HACK')))->>'inserted'`, "0");
  chk("s", "crew_push_change_orders", "cross_write", "readback", "no change order landed on B's job", null, count("public.change_orders", `job_sync_id = ${q(jB2)}`), "0");
  chk("q", "crew_push_change_orders", "cross_write", "control", "A's owner pushes a change order onto A's job", A, `select public.crew_push_change_orders(jsonb_build_array(jsonb_build_object('sync_id', ${q(coY)}, 'job_sync_id', ${q(jA2)}, 'description', 'A25 ORDER')))->>'inserted'`, "1");

  // ---- the join door: the company id is the invite code
  // The call is live and it does refuse: with an id that is not a company it says so. The only thing between a stranger and B is knowing B's id.
  chk("x", "join_company", "join_door", "control", "the same call with an id that is not a company is refused", U.W, `select public.join_company(${q(uuid("4", 95))}, 'A25 stranger', '')`, "ERR P0001");
  chk("x", "join_company", "join_door", "probe", "a signed-in stranger who holds only company B's id joins B", U.W, `select public.join_company(${q(CB)}, 'A25 stranger', '')`, "ERR P0001|ERR 42501");
  chk("q", "join_company", "join_reads_jobs", "probe", "...and reads B's customer list (name, address, phone, email) through the crew view", U.W, count("public.jobs_crew", `company_id = ${q(CB)}`), "0");
  chk("q", "join_company", "join_reads_jobs", "control", "B's own crew member reads the same (the query works, and this is all they see too)", U.BC, count("public.jobs_crew", `company_id = ${q(CB)}`), ">=1");
  chk("q", "join_company", "join_reads_customers", "probe", "...and reads B's customers table", U.W, count("public.customers", `company_id = ${q(CB)}`), "0");
  chk("q", "join_company", "join_reads_customers", "control", "B's own crew member reads the same", U.BC, count("public.customers", `company_id = ${q(CB)}`), ">=1");
  chk("q", "join_company", "join_reads_members", "probe", "...and lists B's members", U.W, `select count(*)::text from public.company_members() where id = ${q(U.BO)}`, "0");
  for (const s of TABLES) {
    if (s.adminOnly) continue;
    chk("q", "join_company", "join_reach", "info", `rows of B's ${s.t} the stranger can read`, U.W, count(`public.${s.t}`, `company_id = ${q(CB)}`), "info");
  }
  chk("q", "join_company", "join_writes_jobs", "probe", "...and marks B's job COMPLETED through the crew door", U.W, `select public.crew_save_job(jsonb_build_object('sync_id', ${q(jB2)}, 'status', 'COMPLETED'))::text`, "false");
  chk("s", "join_company", "join_writes_jobs", "readback", "B's job is still ACCEPTED", null, `select status::text from public.jobs where sync_id = ${q(jB2)}`, "ACCEPTED");
  chk("q", "join_company", "join_writes_jobs", "control", "B's own crew member marks B's other job COMPLETED through the same door", U.BC, `select public.crew_save_job(jsonb_build_object('sync_id', ${q(jB3)}, 'status', 'COMPLETED'))::text`, "true");
  const custB = rid("b", byName.customers), custB2 = uuid("8", byName.customers.i);
  chk("x", "join_company", "join_writes_customers", "probe", "...and edits one of B's customer records (the customers table takes an update from any member)", U.W, `update public.customers set notes = 'A25 STRANGER' where id = ${q(custB)}`, "rows=0");
  chk("s", "join_company", "join_writes_customers", "readback", "B's customer record is untouched", null, `select (notes = '')::text from public.customers where id = ${q(custB)}`, "true");
  chk("x", "join_company", "join_writes_customers", "control", "B's own crew member edits another of B's customer records through the same table", U.BC, `update public.customers set notes = 'A25 CREW' where id = ${q(custB2)}`, "rows=1");
  chk("q", "join_company", "join_reads_members", "control", "B's own crew member lists B's members", U.BC, `select count(*)::text from public.company_members() where id = ${q(U.BO)}`, "1");
}

// =========================================================== verdicts =====
/**
 * Rows from the probe -> one outcome per (subject, attack). A pair is INVALID when
 * its control failed (the refusal proves nothing), LEAK when the attack got
 * through with a working control, ok otherwise. Rows scored "info" never fail.
 */
export function judge(rows) {
  const pairs = new Map();
  for (const r of rows) {
    if (r.tbl === "SUMMARY") continue;
    const key = `${r.tbl}/${r.pair}`;
    if (!pairs.has(key)) pairs.set(key, { key, tbl: r.tbl, pair: r.pair, probes: [], controls: [] });
    (r.role === "control" ? pairs.get(key).controls : r.role === "info" ? [] : pairs.get(key).probes).push(r);
  }
  const out = [];
  for (const p of pairs.values()) {
    const badControl = p.controls.filter((r) => r.result !== "PASS");
    const badProbe = p.probes.filter((r) => r.result !== "PASS");
    out.push({ ...p, status: badControl.length ? "INVALID" : badProbe.length ? "LEAK" : "ok", badControl, badProbe });
  }
  const tables = new Map();
  for (const p of out) {
    const t = tables.get(p.tbl) ?? { tbl: p.tbl, pairs: [], verdict: "isolated" };
    t.pairs.push(p);
    if (p.status === "LEAK") t.verdict = "LEAKS";
    else if (p.status === "INVALID" && t.verdict !== "LEAKS") t.verdict = "could-not-establish";
    tables.set(p.tbl, t);
  }
  return { pairs: out, tables: [...tables.values()] };
}

/** What each pair asserts, in words, for the verdict table. */
export function describe(rows) {
  const r = judge(rows);
  const lines = [];
  for (const t of r.tables) {
    const n = t.pairs.length;
    lines.push(`${t.verdict.toUpperCase().padEnd(20)} ${t.tbl}  (${n} attack${n === 1 ? "" : "s"}: ${t.pairs.map((p) => p.pair + (p.status === "ok" ? "" : `[${p.status}]`)).join(", ")})`);
  }
  return lines.join("\n");
}

// ====================================================== the known ledger ==
/**
 * What is EXPECTED to fail today, as "subject/attack". The live run must fail on
 * exactly this set. A new leak makes the run red; so does fixing one of these
 * without deleting it here, so the record cannot go stale in either direction.
 * Each has its evidence in supabase_r15_tenant_isolation_findings.sql.
 */
export const KNOWN_FINDINGS = {
  // F1. The company's id is the crew invite code, and joining needs nobody's approval.
  "join_company/join_door": "F1 HIGH: a signed-in stranger holding only a company's id joins it as CREW at once (plan seat permitting)",
  "join_company/join_reads_jobs": "F1 HIGH: ...and reads every job of that company through jobs_crew: name, address, phone, email, notes",
  "join_company/join_reads_customers": "F1 HIGH: ...and the whole customers table",
  "join_company/join_reads_members": "F1 HIGH: ...and the member list",
  "join_company/join_writes_jobs": "F1 HIGH: ...and marks any of that company's jobs COMPLETED through the crew door",
  "join_company/join_writes_customers": "F1 HIGH: ...and edits any customer record (name, phone, address, email, notes)",
  // F2. A definer function that takes the company id from the caller.
  "recompute_job_totals/cross_write": "F2 MEDIUM: any signed-in user rewrites another company's job amount_paid/refunded_amount by naming its ids",
  // F3. The same shape, read side.
  "company_allowed/cross_read": "F3 LOW: any signed-in user learns another company's billing standing by naming its id",
  // F4. The operator's crash inbox takes whatever company the caller names.
  "app_errors/ins_b": "F4 LOW: any signed-in user files crash reports attributed to another company (and to its people), unbounded",
  // F5. Needs the victim device's push token, a secret no tenant can read.
  // F6. Not across two companies: inside one, a crew login reads keys the office minted for somebody else.
  "device_keys/crew_read": "F6 LOW (within a company): every member, crew included, reads the unused device keys straight from the table",
  "register_device_token/hijack": "F5 LOW (needs a secret): re-points another device's push token at the caller",
};

// =============================================================== STATIC ===
/** Pairs that are a fact about the schema rather than an attack, so there is nothing to run a control against. */
const CONTROL_EXEMPT = new Set(["jobs/quote_token_default"]);

/** Every SQL problem a probe must never contain, as sentences. */
export function unsafe(sql) {
  const problems = [];
  const code = sql.replace(/--.*$/gm, "");
  if (/service_role/i.test(code)) problems.push("names service_role");
  if (/bypassrls/i.test(code)) problems.push("names bypassrls");
  if (/\b(create|alter|drop)\s+role\b/i.test(code)) problems.push("changes a role");
  if (/set\s+(local\s+)?(session\s+authorization|role\s+(postgres|supabase_admin|service_role|authenticator))/i.test(code)) problems.push("switches to a privileged role");
  if (/\bcommit\b/i.test(code)) problems.push("commits");
  if (/\btruncate\b/i.test(code)) problems.push("truncates");
  if (/\bdrop\s+(table|schema|policy|trigger|function|view|index|column)\b/i.test(code)) problems.push("drops something");
  if (/\balter\s+table\b/i.test(code)) problems.push("alters a table");
  if (/disable\s+row\s+level\s+security|no\s+force\s+row/i.test(code)) problems.push("switches row-level security off");
  if (!/^\s*begin;/i.test(code)) problems.push("does not open with begin;");
  const tail = code.trim().split(/;\s*/).filter(Boolean).pop();
  if (!/^rollback$/i.test(tail ?? "")) problems.push("does not end with rollback;");
  if ((code.match(/\brollback\b/gi) ?? []).length !== 1) problems.push("rollback is not stated exactly once");
  return problems;
}

/**
 * Every UPDATE or DELETE on a public or storage table that has no WHERE. Against real data that is "all of it":
 * if row-level security ever failed, an unkeyed attack statement would have written to every tenant, so each
 * write the probe makes names the synthetic row it is aimed at.
 */
export function unkeyedWrites(sql) {
  const code = sql.replace(/--.*$/gm, "");
  return code.split(";").map((x) => x.trim())
    .filter((x) => /^(update|delete\s+from)\s+(only\s+)?(public\.|storage\.)/i.test(x) && !/\bwhere\b/i.test(x))
    .map((x) => x.slice(0, 80));
}

/** Ids and addresses that leave the a25 namespace: the probe must never name a real one. */
export function strayIdentifiers(sql) {
  const code = sql.replace(/--.*$/gm, "");
  const stray = [];
  for (const m of code.matchAll(/'([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'/gi)) {
    if (!NS.test(m[1])) stray.push(m[1]);
  }
  for (const m of code.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g)) {
    if (!m[0].endsWith("@probe.invalid")) stray.push(m[0]);
  }
  return stray;
}

/** Pairs that have a probe but neither a control nor an info row: a refusal nobody can tell from a typo. */
export function uncontrolled(checks) {
  const by = new Map();
  for (const c of checks) {
    const k = `${c.tbl}/${c.pair}`;
    const e = by.get(k) ?? { probe: 0, control: 0, info: 0 };
    e[c.role === "readback" ? "probe" : c.role] = (e[c.role === "readback" ? "probe" : c.role] ?? 0) + 1;
    by.set(k, e);
  }
  return [...by].filter(([k, e]) => e.probe > 0 && e.control === 0 && e.info === 0 && !CONTROL_EXEMPT.has(k)).map(([k]) => k);
}

const probe = buildProbe();
const sabotaged = buildProbe({ sabotage: true });
const has = (checks, tb, pair, role) => checks.some((c) => c.tbl === tb && c.pair === pair && c.role === role);

test("the probe never names service_role, drops, commits or leaves the a25 namespace", () => {
  assert.deepEqual(unsafe(probe.sql), []);
  assert.deepEqual(strayIdentifiers(probe.sql), []);
  assert.deepEqual(unkeyedWrites(probe.sql), [], "a write with no WHERE would touch every tenant if row-level security ever failed");
  assert.deepEqual(unkeyedWrites(sabotaged.sql), []);
  // The sabotage run adds only policies named zz_a25_sabotage_*, and only there.
  assert.deepEqual(unsafe(sabotaged.sql), []);
  assert.deepEqual(strayIdentifiers(sabotaged.sql), []);
  assert.equal((probe.sql.match(/create policy/gi) ?? []).length, 0);
  const pol = [...sabotaged.sql.matchAll(/create policy (\w+) on public\.(\w+) as permissive for all to public using \(true\) with check \(true\)/g)];
  assert.equal(pol.length, (sabotaged.sql.match(/create policy/gi) ?? []).length);
  assert.ok(pol.every((m) => m[1] === `zz_a25_sabotage_${m[2]}`));
  assert.deepEqual(pol.map((m) => m[2]).sort(), [...TABLE_NAMES, "companies", "profiles"].sort());
});

test("planted: the safety checker catches each thing it exists to catch", () => {
  const ok = "begin;\nselect 1;\nrollback;";
  assert.deepEqual(unsafe(ok), []);
  assert.ok(unsafe(ok.replace("select 1", "set local role service_role")).includes("names service_role"));
  assert.deepEqual(unsafe(["begin;", "-- service_role in a comment is prose", "select 1;", "rollback;"].join("\n")), [], "a comment is prose, not a use");
  assert.ok(unsafe(ok.replace("rollback;", "commit;")).includes("commits"));
  assert.ok(unsafe(ok.replace("rollback;", "select 2;")).includes("does not end with rollback;"));
  assert.ok(unsafe(ok.replace("select 1", "drop policy p on t")).includes("drops something"));
  assert.ok(unsafe(ok.replace("select 1", "alter table t disable row level security")).length > 0);
  assert.ok(unsafe(ok.replace("select 1", "set local role postgres")).includes("switches to a privileged role"));
  assert.ok(unsafe("select 1;\nrollback;").includes("does not open with begin;"));
  assert.deepEqual(strayIdentifiers("select '11111111-2222-4333-8444-555555555555'"), ["11111111-2222-4333-8444-555555555555"]);
  assert.deepEqual(strayIdentifiers("select 'someone@gmail.com'"), ["someone@gmail.com"]);
  assert.deepEqual(unkeyedWrites("update public.jobs set notes = 'x'; delete from public.profiles; delete from rt_out; update public.jobs set a = 1 where id = 'x';"),
    ["update public.jobs set notes = 'x'", "delete from public.profiles"]);
  assert.deepEqual(strayIdentifiers(`select '${uuid("2", 1)}', 'a@probe.invalid'`), []);
});

test("every attacker is a synthetic subject or the anon key, and every probe row is in the a25 namespace", () => {
  for (const c of probe.checks) assert.ok(c.who === null || c.who === undefined || NS.test(c.who), `${c.tbl}/${c.pair} runs as ${c.who}`);
  assert.ok(new Set(Object.values(U)).size === Object.values(U).length, "two subjects share an id");
  for (const v of [...Object.values(U), CA, CB, CX, CY, TOK_A, TOK_B]) assert.match(v, NS);
});

test("every table is attacked six-plus ways and every attack has a control", () => {
  for (const s of TABLES) {
    const want = ["sel_b", "sel_any", "sel_real", "sel_null", "anon", "nocompany_z", "nocompany_y", "upd_b", "del_b", "ins_b", "b_unchanged"];
    if (s.canUpd) want.push("mv_out", "mv_in");
    if (s.canIns && s.uq && !s.single) want.push("ups_b");
    if (s.job && s.canIns) want.push("ref_x");
    if (!s.adminOnly) want.push("sel_sym");
    for (const pair of want) assert.ok(has(probe.checks, s.t, pair, "probe") || has(probe.checks, s.t, pair, "readback"), `${s.t} is not attacked with ${pair}`);
    for (const pair of ["sel_b", "upd_b", "del_b", "ins_b", "b_unchanged"]) {
      assert.ok(has(probe.checks, s.t, pair, "control"), `${s.t}/${pair} has no control`);
    }
  }
  assert.deepEqual(uncontrolled(probe.checks), []);
});

test("planted: a probe with no control is caught", () => {
  const lonely = [{ tbl: "t", pair: "sel_b", role: "probe" }, { tbl: "t", pair: "sel_b", role: "readback" }];
  assert.deepEqual(uncontrolled(lonely), ["t/sel_b"]);
  assert.deepEqual(uncontrolled([...lonely, { tbl: "t", pair: "sel_b", role: "control" }]), []);
  assert.deepEqual(uncontrolled([...lonely, { tbl: "t", pair: "sel_b", role: "info" }]), []);
});

test("the count of checks the generator lists is the count of calls in the SQL", () => {
  const calls = (probe.sql.match(/perform pg_temp\.(q|x|s)\(/g) ?? []).length;
  assert.equal(calls, probe.checks.length);
  assert.ok(probe.checks.length > 800, `only ${probe.checks.length} checks`);
  assert.ok(probe.checks.every((c) => c.tbl && c.pair && c.role && c.k), "a check has no label");
});

test("the judge reads a lost control as INVALID, a passing attack as LEAK, and a clean pair as ok", () => {
  const row = (tbl, pair, role, result) => ({ tbl, pair, role, result, k: "x" });
  const a = judge([row("t", "sel_b", "probe", "PASS"), row("t", "sel_b", "control", "PASS")]);
  assert.equal(a.tables[0].verdict, "isolated");
  const b = judge([row("t", "sel_b", "probe", "FAIL"), row("t", "sel_b", "control", "PASS")]);
  assert.equal(b.tables[0].verdict, "LEAKS");
  const c = judge([row("t", "sel_b", "probe", "PASS"), row("t", "sel_b", "control", "FAIL")]);
  assert.equal(c.tables[0].verdict, "could-not-establish", "a refusal beside a dead control proves nothing");
  const d = judge([row("t", "sel_b", "probe", "FAIL"), row("t", "sel_b", "control", "FAIL")]);
  assert.equal(d.tables[0].verdict, "could-not-establish", "with no working control, a failure is not a leak either");
  assert.equal(judge([row("SUMMARY", "-", "-", "PASS")]).tables.length, 0);
});

test("the scorer in SQL agrees with the JS about what a want means", () => {
  // The SQL text is checked, not run: exact, prefix ERR, >=N, info and | alternatives.
  assert.match(PRELUDE, /when alt = 'info' then true/);
  assert.match(PRELUDE, /when alt like '>=%'/);
  assert.match(PRELUDE, /when alt like 'ERR %' then got like alt \|\| '%'/);
  assert.match(PRELUDE, /string_to_array\(want, '\|'\)/);
});

// ================================================================ LIVE ===
function runSql(sql, label) {
  const dir = mkdtempSync(join(tmpdir(), "a25-"));
  const file = join(dir, "probe.sql");
  writeFileSync(file, sql, "utf8");
  let last = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = spawnSync("npx", ["--no-install", "supabase@2.115.0", "db", "query", "--linked", "--project-ref", PROJECT, "-f", file, "--output", "json"],
      { encoding: "utf8", shell: process.platform === "win32", timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
    const err = `${r.stderr ?? ""}${r.stdout ?? ""}`;
    // A SQL error is an answer, not a flake: never retry it, never read it as "no rows".
    if (/Failed to run sql query|ERROR:/.test(err) && !/"rows"/.test(r.stdout ?? "")) {
      throw new Error(`${label}: the database refused the probe:\n${err.slice(0, 1500)}`);
    }
    if (r.status === 0) {
      const out = r.stdout ?? "";
      const a = out.indexOf("{"), b = out.lastIndexOf("}");
      if (a >= 0 && b > a) {
        const parsed = JSON.parse(out.slice(a, b + 1));
        const rows = Array.isArray(parsed) ? parsed : parsed.rows;
        if (Array.isArray(rows) && rows.length > 0) return rows;
      }
    }
    last = err.slice(0, 600);
  }
  throw new Error(`${label}: no usable answer after 3 attempts (a failed call is not an empty result): ${last}`);
}

function assertLandedInOrder(rows, checks, label) {
  const last = rows[rows.length - 1];
  assert.equal(last.tbl, "SUMMARY", `${label}: no SUMMARY row`);
  assert.equal(rows.length, checks.length + 1, `${label}: ${rows.length - 1} rows came back for ${checks.length} checks: a check was lost`);
  checks.forEach((c, i) => {
    assert.equal(rows[i].tbl, c.tbl, `${label}: row ${i} is ${rows[i].tbl}, expected ${c.tbl}`);
    assert.equal(rows[i].k, c.k, `${label}: row ${i} is "${rows[i].k}", expected "${c.k}"`);
  });
  const [ok, total] = last.got.split("/").map(Number);
  assert.equal(total, checks.length, `${label}: SUMMARY counts ${total} checks, expected ${checks.length}`);
  return { ok, total };
}

function assertNothingLeft() {
  const rows = runSql(`select
    (select count(*) from auth.users where email like 'a25-%@probe.invalid') as users,
    (select count(*) from public.companies where name like 'PROBE-A25%' or id::text like 'a25%') as companies,
    (select count(*) from public.profiles where id::text like 'a25%') as profiles,
    (select count(*) from pg_policies where policyname like 'zz_a25_%') as policies,
    (select count(*) from storage.objects where name like '%/a25/%') as objects,
    (select count(*) from public.jobs where id::text like 'a25%' or company_id::text like 'a25%') as jobs,
    (select count(*) from public.payment_records where company_id::text like 'a25%') as payments,
    (select count(*) from public.device_tokens where token like 'a25-%') as tokens,
    (select count(*) from public.app_errors where message like 'A25%') as errors,
    (select count(*) from public.audit_log where company_id::text like 'a25%') as audit,
    (select count(*) from realtime.subscription where claims::text like '%a25%') as subscriptions,
    (select count(*) from net.http_request_queue where body::text ilike '%a25%' or url ilike '%a25%') as http_calls;`, "leftover check");
  assert.deepEqual(rows[0], { users: 0, companies: 0, profiles: 0, policies: 0, objects: 0, jobs: 0, payments: 0, tokens: 0, errors: 0, audit: 0, subscriptions: 0, http_calls: 0 },
    "the probe left something behind (or queued an HTTP call): the rollback did not happen");
}

/** Every table and view in public, so a new one cannot be forgotten. */
const SPECIAL_TABLES = ["companies", "profiles", "device_tokens", "notification_prefs", "app_errors"];
const SPECIAL_ADMIN = { app_release_audience: "operator-only: read by the platform operator, never a tenant", app_releases: "app releases: public unless targeted at named companies; carries no tenant data" };
const OPERATOR_VIEWS = ["platform_clients", "admin_release_audience"];

test("LIVE: every table and view in the public schema is attacked here or explained here", { skip: !LIVE }, () => {
  const rows = runSql(`select c.relname, c.relkind::text as kind from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','v','m','p') order by 1;`, "catalogue");
  const covered = new Set([...TABLE_NAMES, ...NO_GRANT_TABLES, ...OPERATOR_ONLY_TABLES, ...SPECIAL_TABLES, ...Object.keys(SPECIAL_ADMIN), ...CREW_VIEWS, ...OPERATOR_VIEWS]);
  const missing = rows.filter((r) => !covered.has(r.relname)).map((r) => `${r.kind}:${r.relname}`);
  assert.deepEqual(missing, [], "a table or view exists that no probe here attacks; add it, or say why it is not tenant data");
  const pub = runSql(`select tablename from pg_publication_tables where pubname = 'supabase_realtime' order by 1;`, "publication").map((r) => r.tablename);
  const unwatched = pub.filter((n) => !REALTIME_TABLES.includes(n) && !(n in REALTIME_UNPROBED));
  assert.deepEqual(unwatched, [], "a table is published to Realtime that no probe here subscribes to");
  assert.deepEqual(REALTIME_TABLES.filter((n) => !pub.includes(n)), [], "the probe subscribes to a table Realtime no longer publishes");
  const gone = [...covered].filter((n) => !rows.some((r) => r.relname === n) && !Object.keys(SPECIAL_ADMIN).includes(n));
  assert.deepEqual(gone, [], "the probe attacks a table that no longer exists");
});

let liveRows = null;
test("LIVE: the attack, table by table -- fails on exactly the known findings, nothing new", { skip: !LIVE, timeout: 600_000 }, () => {
  if (process.env.A25_DUMP) writeFileSync(process.env.A25_DUMP, probe.sql, "utf8");
  const rows = runSql(probe.sql, "probe");
  liveRows = rows;
  const { ok, total } = assertLandedInOrder(rows, probe.checks, "probe");
  const j = judge(rows);
  const summary = describe(rows);
  console.log(`\nTENANT ISOLATION VERDICT (${ok}/${total} checks passed)\n${summary}\n`);
  const bad = j.pairs.filter((p) => p.status !== "ok");
  for (const p of bad) {
    console.log(`  ${p.status} ${p.key}`);
    for (const r of [...p.badControl, ...p.badProbe]) console.log(`      ${r.role}: ${r.k}\n        got  ${r.got}\n        want ${r.want}`);
  }
  if (process.env.A25_VERDICT) writeFileSync(process.env.A25_VERDICT, JSON.stringify({ summary: `${ok}/${total}`, tables: j.tables.map((t) => ({ tbl: t.tbl, verdict: t.verdict, pairs: t.pairs.map((p) => ({ pair: p.pair, status: p.status })) })), failing: bad.map((p) => ({ key: p.key, status: p.status, rows: [...p.badControl, ...p.badProbe].map((r) => ({ role: r.role, k: r.k, got: r.got, want: r.want })) })), info: rows.filter((r) => r.role === "info").map((r) => ({ tbl: r.tbl, pair: r.pair, k: r.k, got: r.got })), all: rows.map((r) => ({ n: r.n, tbl: r.tbl, pair: r.pair, role: r.role, k: r.k, got: r.got, want: r.want, result: r.result })) }, null, 1), "utf8");
  assert.deepEqual(bad.filter((p) => p.status === "INVALID").map((p) => p.key), [], "a control died: those attacks prove nothing");
  assert.deepEqual(bad.filter((p) => p.status === "LEAK").map((p) => p.key).sort(), Object.keys(KNOWN_FINDINGS).sort(),
    "the set of leaks is not the set recorded in KNOWN_FINDINGS: a new leak, or a recorded one fixed");
  assertNothingLeft();
});

// The wall must have teeth: a policy that lets everyone in has to turn the isolation checks red.
const DEEP_UPDATE = new Set(["time_entries"]);   // a second, RESTRICTIVE company policy on UPDATE holds even when the permissive one is opened
test("LIVE: with an allow-all policy planted on every tenant table, the isolation checks go red (the probe has teeth)", { skip: !LIVE, timeout: 600_000 }, () => {
  const rows = runSql(sabotaged.sql, "sabotaged probe");
  assertLandedInOrder(rows, sabotaged.checks, "sabotaged probe");
  const j = judge(rows);
  const pair = (t, p) => j.pairs.find((x) => x.tbl === t && x.pair === p);
  const shouldFail = [];
  for (const s of TABLES) {
    shouldFail.push([s.t, "sel_b"], [s.t, "sel_any"], [s.t, "sel_real"]);
    if (s.canIns) shouldFail.push([s.t, "ins_b"]);
    if (s.canUpd && !DEEP_UPDATE.has(s.t)) shouldFail.push([s.t, "upd_b"]);
  }
  for (const t of REALTIME_TABLES) shouldFail.push([`realtime.${t}`, "ins_b"]);
  shouldFail.push(["companies", "sel_b"], ["companies", "upd_b"], ["profiles", "sel_b"], ["profiles", "upd_b"]);
  const stillGreen = shouldFail.filter(([t, p]) => pair(t, p)?.status !== "LEAK");
  assert.deepEqual(stillGreen.map(([t, p]) => `${t}/${p}`), [], "an allow-all policy did not turn these red: their checks have no teeth");
  assertNothingLeft();
});

// ==================================================== the findings record ===
const FINDINGS_FILE = "supabase_r15_tenant_isolation_findings.sql";
const findingsSql = () => readFileSync(join(ROOT, FINDINGS_FILE), "utf8");

/** The SQL between `-- >>> FIX Fn` and `-- <<< FIX Fn`, keyed by n. */
export function fixBlocks(sql) {
  const out = {};
  for (const m of sql.matchAll(/^-- >>> FIX (F\d+)\s*$([\s\S]*?)^-- <<< FIX \1\s*$/gm)) out[m[1]] = m[2].trim();
  return out;
}

/** What a fix migration must never do: touch rows, drop, rename, or commit. Function bodies are read separately. */
export function destructiveFix(sql) {
  const src = sql.replace(/--.*$/gm, "").replace(/\$function\$[\s\S]*?\$function\$/g, "").replace(/\$fix\$[\s\S]*?\$fix\$/g, "");
  const problems = [];
  if (/\bdelete\s+from\b/i.test(src)) problems.push("deletes rows");
  if (/\btruncate\b/i.test(src)) problems.push("truncates");
  if (/\bupdate\s+(public\.)?\w+\s+set\b/i.test(src)) problems.push("rewrites rows");
  if (/\binsert\s+into\b/i.test(src)) problems.push("inserts rows");
  if (/\bdrop\b/i.test(src)) problems.push("drops something");
  if (/\balter\s+table\b/i.test(src)) problems.push("alters a table");
  if (/\bcommit\b/i.test(src)) problems.push("commits");
  if (/service_role/i.test(src)) problems.push("names service_role");
  return problems;
}

/** What each fix is expected to turn green, so the ledger and the proof cannot drift apart. */
export const FIXED_BY = {
  F2: ["recompute_job_totals/cross_write"],
  F3: ["company_allowed/cross_read"],
  F4: ["app_errors/ins_b"],
  F5: ["register_device_token/hijack"],
  F6: ["device_keys/crew_read"],
};

test("the findings file says it is unapplied, is one rolled-back transaction, and its fixes touch no data", () => {
  const sql = findingsSql();
  assert.match(sql.slice(0, 600), /STATUS: NOT APPLIED/);
  const code = sql.replace(/--.*$/gm, "");
  assert.match(code.trim(), /^begin;/i);
  assert.match(code.trim(), /rollback;$/i);
  assert.equal((code.match(/\bcommit\b/gi) ?? []).length, 0);
  assert.equal((code.match(/\brollback\b/gi) ?? []).length, 1);
  assert.deepEqual(destructiveFix(sql), []);
  assert.doesNotMatch(code, /service_role/i);
  const blocks = fixBlocks(sql);
  assert.deepEqual(Object.keys(blocks).sort(), Object.keys(FIXED_BY).sort());
  for (const [n, b] of Object.entries(blocks)) assert.ok(b.length > 40, `${n} is empty`);
  // Every finding recorded in the ledger has its section in the file, and every fix targets one.
  for (const [key, why] of Object.entries(KNOWN_FINDINGS)) {
    const n = why.match(/^F(\d+)/)?.[1];
    assert.ok(n, `${key} carries no finding number`);
    assert.match(sql, new RegExp(`^-- F${n}\\b`, "m"), `${key}: F${n} has no section in ${FINDINGS_FILE}`);
  }
  const ledger = new Set(Object.keys(KNOWN_FINDINGS));
  for (const [n, pairs] of Object.entries(FIXED_BY)) for (const p of pairs) assert.ok(ledger.has(p), `${n} claims to fix ${p}, which is not a recorded finding`);
});

test("planted: the fix checker catches a delete, a rewrite, a drop and a commit", () => {
  assert.deepEqual(destructiveFix("revoke all on function f() from public;"), []);
  assert.ok(destructiveFix("delete from public.jobs;").includes("deletes rows"));
  assert.ok(destructiveFix("update public.jobs set notes = '';").includes("rewrites rows"));
  assert.ok(destructiveFix("drop policy p on public.jobs;").includes("drops something"));
  assert.ok(destructiveFix("commit;").includes("commits"));
  assert.ok(destructiveFix("grant all on t to service_role;").includes("names service_role"));
  assert.deepEqual(destructiveFix("create function f() returns void as $function$ begin delete from x where true; end $function$ language plpgsql;"), [],
    "a function body is read by the function-level check, not this one");
  assert.deepEqual(fixBlocks("-- >>> FIX F9\nselect 1;\n-- <<< FIX F9\n"), { F9: "select 1;" });
});

test("LIVE: the proposed fixes, applied inside the rolled-back transaction, close F2-F6 and change nothing else", { skip: !(LIVE && process.env.A25_FIXES === "1"), timeout: 600_000 }, () => {
  const blocks = fixBlocks(findingsSql());
  const sql = `begin;\nset local lock_timeout = '5s';\n${Object.values(blocks).join("\n")}\n${probe.sql}`;
  const rows = runSql(sql, "probe with the fixes");
  assertLandedInOrder(rows, probe.checks, "probe with the fixes");
  const j = judge(rows);
  const bad = j.pairs.filter((p) => p.status !== "ok");
  for (const p of bad) console.log(`  after the fixes: ${p.status} ${p.key}`);
  assert.deepEqual(bad.filter((p) => p.status === "INVALID").map((p) => p.key), [], "a control died under the fixes");
  const fixed = new Set(Object.values(FIXED_BY).flat());
  const expected = Object.keys(KNOWN_FINDINGS).filter((k) => !fixed.has(k)).sort();
  assert.deepEqual(bad.filter((p) => p.status === "LEAK").map((p) => p.key).sort(), expected,
    "with the fixes in, exactly the findings that have no fix here (F1) may remain");
  assertNothingLeft();
});
