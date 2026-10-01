// The CANCELLATION clause in the contract terms.
//
// WHY THIS EXISTS. The shipped terms asked the owner to fill in a notice period and a
// restocking charge, in a bracketed block that printed on the contract if he did not.
// He asked for the clause to be written for him. It now charges what a cancelled job
// has ACTUALLY cost -- materials that cannot be returned, return charges the supplier
// really bills, work already done -- so it needs no figure from him, and states none.
//
// WHAT THESE GUARD, in the order a regression would hurt:
//   1. The terms live in exactly one file. A clause added to a second copy is one the
//      owner believes is there and no customer ever sees.
//   2. No figure creeps back in. A number in this clause prints on a real customer's
//      contract as though it were the owner's policy; this app does not know his.
//   3. The statutory right-to-cancel block is NOT removed by accident. It is attorney
//      wording; the app warns, and gates sending, while it is still in the text.
//   4. A stored copy of an old default keeps following this file. The terms an owner
//      sees are written into the phone's own storage the first time settings are
//      saved, so changing the constant alone changes nothing on a phone that saved
//      before. The old defaults are recognised by fingerprint; every one this project
//      ever shipped must be on that list, and this test reads git to prove it.
//
// The Kotlin unit tests cannot run while a release build owns Gradle, so the string
// assertions they make are repeated here against the same source.
//
// Run: node --test tests/a42-cancellation-clause.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = "app/src/main/java/com/fenceestimator/app/data/ContractTemplate.kt";
const src = readFileSync(path.join(ROOT, TEMPLATE), "utf8");
const CR = String.fromCharCode(13);

function constantIn(text, name) {
  const key = "const val " + name + ': String = """';
  const i = text.indexOf(key);
  if (i < 0) return null;
  const j = text.indexOf('"""', i + key.length);
  return text.slice(i + key.length, j);
}
const NAMES = { EN: "DEFAULT_CONTRACT_TERMS", ES: "DEFAULT_CONTRACT_TERMS_ES", FR: "DEFAULT_CONTRACT_TERMS_FR" };
const cur = { EN: constantIn(src, NAMES.EN), ES: constantIn(src, NAMES.ES), FR: constantIn(src, NAMES.FR) };

// Heading of the cancellation section, and of the statutory block that ends it.
const HEAD = { EN: "CANCELLATION", ES: "CANCELACIÓN", FR: "ANNULATION" };
const NEXT = { EN: "YOUR RIGHT TO CANCEL", ES: "SU DERECHO A CANCELAR", FR: "VOTRE DROIT D'ANNULATION" };
const REPLACE_MARK = {
  EN: "[REPLACE THIS BLOCK BEFORE USING THIS CONTRACT]",
  ES: "[REEMPLACE ESTE BLOQUE ANTES DE USAR ESTE CONTRATO]",
  FR: "[REMPLACEZ CE BLOC AVANT D'UTILISER CE CONTRAT]",
};
function section(lang) {
  const t = cur[lang];
  const a = t.indexOf("\n" + HEAD[lang] + "\n");
  const b = t.indexOf("\n" + NEXT[lang]);
  assert.ok(a >= 0 && b > a, lang + ": cancellation section or the block after it was not found");
  return t.slice(a + 1, b);
}

// Same recipe as termsFingerprint in ContractTemplate.kt: trim, CRLF to LF, SHA-256 of UTF-8.
function fingerprint(text) {
  const canonical = text.trim().split(CR + "\n").join("\n");
  return createHash("sha256").update(Buffer.from(canonical, "utf8")).digest("hex");
}

test("positive control: all three defaults and their cancellation sections are found", () => {
  for (const lang of ["EN", "ES", "FR"]) {
    assert.ok(cur[lang] && cur[lang].length > 3000, lang + " default missing or truncated");
    assert.ok(section(lang).length > 1200, lang + " cancellation section is suspiciously short");
  }
});

test("the contract terms text lives in exactly one source file", () => {
  // Scoped to the places a copy could be served from: the app, the web pages and the
  // edge functions. A second copy is a second place the owner would have to edit.
  const roots = ["app/src", "website", "supabase/functions", "scripts"];
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "build" || name === ".gradle" || name === ".git") continue;
      const p = path.join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/[.](kt|xml|html|js|mjs|ts|json|md)$/.test(name) && st.size < 3000000) {
        const text = readFileSync(p, "utf8");
        if (text.includes("UNDERGROUND UTILITIES") && text.includes("PROPERTY LINES")) {
          hits.push(path.relative(ROOT, p).split(path.sep).join("/"));
        }
      }
    }
  };
  for (const r of roots) walk(path.join(ROOT, r));
  assert.deepEqual(hits, [TEMPLATE]);
});

test("the clause covers the cases an owner actually meets, in all three languages", () => {
  const must = {
    EN: [
      "before materials are ordered", "is refunded in", "cut to", "cannot be returned",
      "supplier's invoice", "left over", "installation has begun", "work already done",
      "{COMPANY} cancels this agreement", "must be in writing", "text message",
      "any right to cancel that the law gives you",
    ],
    ES: [
      "antes de pedir los materiales", "se le reembolsa", "ya cortado", "no se pueden devolver",
      "factura del proveedor", "instalación haya comenzado", "trabajo ya realizado",
      "{COMPANY} cancela este acuerdo", "por escrito", "mensaje de texto", "derecho de cancelación",
    ],
    FR: [
      "avant la commande des matériaux", "remboursé", "déjà coupé", "ne peuvent pas être retournés",
      "facture du fournisseur", "début de l'installation", "travail déjà effectué",
      "{COMPANY} annule le présent accord", "par écrit", "SMS", "droit d'annulation",
    ],
  };
  for (const lang of ["EN", "ES", "FR"]) {
    const s = section(lang);
    for (const phrase of must[lang]) {
      assert.ok(s.includes(phrase), lang + ": the clause no longer says \"" + phrase + "\"");
    }
  }
});

test("the clause states no figure: no digit, percentage or currency amount", () => {
  for (const lang of ["EN", "ES", "FR"]) {
    const s = section(lang);
    assert.ok(!/[0-9]/.test(s), lang + ": a digit is in the cancellation clause");
    assert.ok(!s.includes("%"), lang + ": a percentage is in the cancellation clause");
    assert.ok(!s.includes("$"), lang + ": a currency amount is in the cancellation clause");
    // Spelled-out numbers of days are figures too.
    assert.ok(!/(business|calendar) days?|días hábiles|jours ouvrables/i.test(s),
      lang + ": a number of days is in the cancellation clause");
  }
});

test("no default asks the owner to fill anything in, and the statutory block is still there", () => {
  for (const lang of ["EN", "ES", "FR"]) {
    const t = cur[lang];
    for (const gone of ["FILL THIS IN", "COMPLETE ESTO", "REMPLISSEZ CECI", "NOTICE AND RESTOCKING", "AVISO Y CARGO", "AVIS ET FRAIS"]) {
      assert.ok(!t.includes(gone), lang + ": the old fill-in block is back (" + gone + ")");
    }
    // The statutory block is attorney wording. It must still be the one bracketed marker:
    // removing it would switch off the warning and the pre-send gate without anyone
    // having supplied the wording.
    assert.ok(t.includes(REPLACE_MARK[lang]), lang + ": the right-to-cancel marker was removed");
    assert.equal(t.split("[").length - 1, 1, lang + ": there is more than one bracketed marker");
  }
});

test("the three languages carry the same placeholders, in the same number of paragraphs", () => {
  const ALLOWED = new Set(["{COMPANY}", "{ADDRESS}", "{TOTAL}", "{DEPOSIT}", "{WARRANTY_PERIOD}"]);
  const paragraphs = {};
  for (const lang of ["EN", "ES", "FR"]) {
    for (const tok of cur[lang].match(/[{][A-Z_]+[}]/g) || []) {
      assert.ok(ALLOWED.has(tok), lang + ": " + tok + " is not a placeholder the PDF fills in, so it would print as typed");
    }
    paragraphs[lang] = section(lang).trim().split("\n\n").length;
  }
  assert.equal(paragraphs.ES, paragraphs.EN, "Spanish clause has a different number of paragraphs");
  assert.equal(paragraphs.FR, paragraphs.EN, "French clause has a different number of paragraphs");
  // {COMPANY} is how the clause names the contractor; it must be in every language.
  for (const lang of ["EN", "ES", "FR"]) assert.ok(section(lang).includes("{COMPANY}"), lang + ": {COMPANY} missing");
});

test("every default this project ever shipped is recognised, so a stored old copy follows this file", () => {
  // Every committed version of the three constants, from git.
  const shas = execFileSync("git", ["log", "--format=%H", "--", TEMPLATE], { cwd: ROOT, encoding: "utf8" })
    .split("\n").map((x) => x.trim()).filter(Boolean);
  assert.ok(shas.length >= 6, "expected at least six commits touching the template, git returned " + shas.length +
    " (a shallow clone cannot run this check)");
  const currentPrints = new Set(Object.values(cur).map(fingerprint));
  const historical = new Set();
  for (const sha of shas) {
    const old = execFileSync("git", ["show", sha + ":" + TEMPLATE], { cwd: ROOT, encoding: "utf8", maxBuffer: 20000000 });
    for (const lang of ["EN", "ES", "FR"]) {
      const body = constantIn(old, NAMES[lang]);
      if (body === null) continue;     // ES and FR did not exist in the earliest commits
      const fp = fingerprint(body);
      if (!currentPrints.has(fp)) historical.add(fp);
    }
  }
  assert.ok(historical.size >= 9, "expected at least nine superseded defaults in git history, found " + historical.size);

  // The fingerprints the Kotlin file carries.
  const open = src.indexOf("SUPERSEDED_DEFAULT_TERMS_SHA256: Set<String> = setOf(");
  assert.ok(open >= 0, "the superseded-defaults list was not found in " + TEMPLATE);
  const close = src.indexOf("\n)", open);
  const listed = new Set(src.slice(open, close).match(/"[0-9a-f]{64}"/g).map((q) => q.slice(1, -1)));

  const missing = [...historical].filter((h) => !listed.has(h));
  const invented = [...listed].filter((h) => !historical.has(h));
  assert.deepEqual(missing, [], "a default that shipped before is not on the list, so a phone holding it keeps printing it: " + missing.join(", "));
  assert.deepEqual(invented, [], "the list holds a fingerprint that matches no shipped default: " + invented.join(", "));
  for (const fp of currentPrints) assert.ok(!listed.has(fp), "a CURRENT default is on the superseded list");
});

test("the fingerprint ignores surrounding whitespace and line-ending style, like the Kotlin one", () => {
  const t = cur.EN;
  assert.equal(fingerprint(t), fingerprint("\n\n" + t + "\n   "));
  assert.equal(fingerprint(t), fingerprint(t.split("\n").join(CR + "\n")));
  assert.notEqual(fingerprint(t), fingerprint(t.replace("CANCELLATION", "CANCELLATION (edited)")));
  assert.match(src, /terms[.]trim[(][)][.]replace[(]/, "the Kotlin fingerprint no longer trims and normalises line endings");
});
