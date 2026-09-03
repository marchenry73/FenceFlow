#!/usr/bin/env node
/**
 * Writes a normalised fingerprint of a Supabase project's public schema.
 *
 * This exists because `supabase db dump` cannot run on this machine: it shells
 * out to pg_dump inside Docker, and Docker is not installed here. It also wants
 * the database password, which lives only in March's head. `db query` goes
 * through the Management API instead -- no Docker, no password, just the CLI
 * login that is already there.
 *
 * What it captures: tables, columns, constraints, indexes, RLS flags, policies,
 * functions (signature + body hash), triggers, enums, views, extensions,
 * realtime publication membership, storage buckets, and role grants. What it
 * never captures: a single row of anybody's data. The output is schema shape
 * only, which is why it is safe to commit to a public repository.
 *
 * Usage:
 *   node scripts/schema-fingerprint.mjs <project-ref> <output-file>
 *
 * Compare two of them with scripts/schema-diff.mjs.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

const FINGERPRINT_SQL = `
-- Policy expressions and trigger definitions come back with newlines in them,
-- which would split one entry across several lines and make the diff report
-- fragments instead of facts. Collapsing runs of whitespace also means two
-- projects that formatted the same expression differently still compare equal.
select regexp_replace(line, '[[:space:]]+', ' ', 'g') as line from (
  select format('TABLE    %s  rls=%s', c.relname, c.relrowsecurity) as line
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'

  union all
  select format('COLUMN   %s.%s  %s  %s  default=%s',
                c.relname, a.attname, format_type(a.atttypid, a.atttypmod),
                case when a.attnotnull then 'notnull' else 'null' end,
                coalesce(pg_get_expr(d.adbin, d.adrelid), '-'))
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
   where n.nspname = 'public' and c.relkind = 'r'

  union all
  select format('CONSTR   %s.%s  %s', c.relname, con.conname, pg_get_constraintdef(con.oid))
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'

  union all
  select format('INDEX    %s  %s', i.indexname, i.indexdef)
    from pg_indexes i where i.schemaname = 'public'

  union all
  select format('POLICY   %s.%s  cmd=%s roles=%s using=%s check=%s',
                p.tablename, p.policyname, p.cmd,
                array_to_string(p.roles, ','),
                coalesce(p.qual, '-'), coalesce(p.with_check, '-'))
    from pg_policies p where p.schemaname = 'public'

  -- Body hashed rather than included: the point is "same or not same", and a
  -- hundred function bodies inline would bury every other difference.
  union all
  select format('FUNC     %s(%s)  returns=%s secdef=%s volatility=%s body_md5=%s',
                p.proname, pg_get_function_identity_arguments(p.oid),
                pg_get_function_result(p.oid), p.prosecdef, p.provolatile,
                md5(coalesce(p.prosrc, '')))
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'

  union all
  select format('TRIGGER  %s', pg_get_triggerdef(t.oid))
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and not t.tgisinternal

  union all
  select format('ENUM     %s  %s', tt.typname,
                string_agg(e.enumlabel, ',' order by e.enumsortorder))
    from pg_type tt
    join pg_enum e on e.enumtypid = tt.oid
    join pg_namespace n on n.oid = tt.typnamespace
   where n.nspname = 'public'
   group by tt.typname

  union all
  select format('VIEW     %s  definition_md5=%s', v.viewname, md5(v.definition))
    from pg_views v where v.schemaname = 'public'

  union all
  select format('EXTENSION %s %s', e.extname, e.extversion) from pg_extension e

  -- Realtime is opt-in per table. A dev project missing this looks identical
  -- until a payment lands and nothing on the phone moves.
  union all
  select format('REALTIME %s.%s', pt.schemaname, pt.tablename)
    from pg_publication_tables pt where pt.pubname = 'supabase_realtime'

  -- Bucket configuration, not bucket contents.
  union all
  select format('BUCKET   %s public=%s', b.id, b.public) from storage.buckets b

  union all
  select format('GRANT    %s %s %s', g.table_name, g.grantee, g.privilege_type)
    from information_schema.role_table_grants g
   where g.table_schema = 'public'
     and g.grantee in ('anon', 'authenticated', 'service_role')
) s
order by 1;
`;

const ref = process.argv[2];
const outFile = process.argv[3];
if (!ref || !outFile) {
  console.error("Usage: node scripts/schema-fingerprint.mjs <project-ref> <output-file>");
  process.exit(1);
}

const sqlFile = join(tmpdir(), `ff-fingerprint-${process.pid}.sql`);
writeFileSync(sqlFile, FINGERPRINT_SQL);

let raw;
try {
  // --linked AND --project-ref together. Neither works alone: --project-ref is
  // rejected as mutually exclusive without --linked, and --linked alone cannot
  // find the ref because this repo's link file predates the CLI's current
  // format. The pair is what backup-cloud.mjs already uses.
  //
  // shell:true because npx is a .cmd on Windows and Node refuses to exec one
  // directly (EINVAL).
  raw = execFileSync(
    "npx.cmd",
    ["-y", "supabase", "db", "query", "--linked", "--project-ref", ref, "-f", `"${sqlFile}"`],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, shell: true, stdio: ["ignore", "pipe", "pipe"] }
  );
} finally {
  rmSync(sqlFile, { force: true });
}

const start = raw.indexOf("{");
if (start < 0) {
  console.error("No JSON in CLI output. Raw response:\n" + raw.slice(0, 2000));
  process.exit(1);
}
const rows = JSON.parse(raw.slice(start)).rows ?? [];
// Policy expressions and trigger definitions come back with newlines in them,
// which would split one entry across several lines and make the diff report
// fragments instead of facts. Collapsing whitespace also means two projects
// that formatted the same expression differently still compare equal.
const lines = rows.map(r => r.line);

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, lines.join("\n") + "\n", "utf8");

const counts = {};
for (const l of lines) {
  const kind = l.split(/\s+/)[0];
  counts[kind] = (counts[kind] ?? 0) + 1;
}
console.log(`Fingerprint of ${ref} -> ${outFile}`);
console.log(`${lines.length} lines`);
for (const k of Object.keys(counts).sort()) console.log(`  ${k.padEnd(10)} ${counts[k]}`);
