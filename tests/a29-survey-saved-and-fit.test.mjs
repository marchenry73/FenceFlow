// A29 -- the survey photo is SAVED, can be used as the background, and can be FITTED.
//
// He asked: "for the survey, I just want it to be saved, and also the option to
// use it in the picture and for it to be recalibrated in there to fit, whether
// to zoom in or zoom out, move something, whatever needs to be done."
//
// The behaviour itself (scale rules, the fit arithmetic, what Use Grid may write)
// is held to JVM tests: app/src/test/.../survey/SurveyFitTest.kt and
// SurveySavedTest.kt. This file covers the two things those cannot, and runs
// under plain `node --test` with no Gradle:
//
//  1. THE WORDING. The survey controls look their text up by resource name and
//     fall back to English (SurveyDrawScreen.fitText), because the strings.xml
//     files they belong in were being edited by other work and a reference to a
//     missing resource fails the whole build. So the wording has to be handed
//     over and then PICKED UP -- and a name that drifts between this table, the
//     Kotlin fallback and the resource files would silently leave a phone in
//     English, or crash a format call in one language. PROPOSED below is the
//     single table; the checks keep the code, the table and (once they exist)
//     the resources in step.
//
//  2. THE ARITHMETIC, a second time and independently. The Kotlin rule is
//     p' = (p - t) / f and calibration' = calibration / f. This re-derives it in
//     JavaScript with float32 rounding (Math.fround) on random drawings and
//     checks the footage does not move -- so a mistake that the Kotlin test and
//     the Kotlin implementation share (the same wrong idea written twice) would
//     still be caught here.
//
// Run: node --test tests/a29-survey-saved-and-fit.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");
const SCREEN = "app/src/main/java/com/fenceestimator/app/ui/survey/SurveyDrawScreen.kt";
const screen = read(SCREEN);

// ---------------------------------------------------------------------------
// The wording: name -> { en, es, fr }, in resource form (apostrophes unescaped here;
// escaped when emitted as XML). Arguments are numbered, as every resource string is.
// ---------------------------------------------------------------------------
const PROPOSED = {
  survey_grid_needs_scale: {
    en: "Calibrate the photo first. What you drew on it has no scale yet, so the grid cannot measure it.",
    es: "Calibra primero la foto. Lo que dibujaste en ella aún no tiene escala, así que la cuadrícula no puede medirlo.",
    fr: "Calibrez d'abord la photo. Ce que vous avez tracé dessus n'a pas encore d'échelle, la grille ne peut donc pas le mesurer.",
  },
  survey_fit_refused: {
    en: "The fit could not be applied, so nothing was changed.",
    es: "No se pudo aplicar el ajuste, así que no se cambió nada.",
    fr: "L'ajustement n'a pas pu être appliqué ; rien n'a été modifié.",
  },
  survey_import_already: {
    en: "This job already has a survey photo. It stays saved with the job.",
    es: "Este trabajo ya tiene una foto del plano. Sigue guardada con el trabajo.",
    fr: "Ce chantier a déjà une photo du relevé. Elle reste enregistrée avec le chantier.",
  },
  survey_import_failed: {
    en: "That photo could not be read, so nothing was saved.",
    es: "No se pudo leer esa foto, así que no se guardó nada.",
    fr: "Cette photo n'a pas pu être lue ; rien n'a été enregistré.",
  },
  survey_scale_unmeasured: {
    en: "Scale NOT measured on this photo -- lengths are only as good as the fit. Use Calibrate to measure it.",
    es: "Escala SIN medir en esta foto: las longitudes solo son tan buenas como el ajuste. Usa Calibrar para medirla.",
    fr: "Échelle NON mesurée sur cette photo : les longueurs ne valent que ce que vaut l'ajustement. Utilisez Calibrer pour la mesurer.",
  },
  survey_scale_measured: {
    en: "Scale measured against a %1$s ft reference",
    es: "Escala medida con una referencia de %1$s pies",
    fr: "Échelle mesurée sur une référence de %1$s pi",
  },
  survey_fit_hint: {
    en: "Drag to move the photo, pinch to zoom it, until it lines up with your drawing.",
    es: "Arrastra para mover la foto y pellizca para acercarla o alejarla, hasta que coincida con tu dibujo.",
    fr: "Faites glisser pour déplacer la photo, pincez pour zoomer, jusqu'à ce qu'elle coïncide avec votre dessin.",
  },
  survey_fit_effect: {
    en: "Every length you drew stays exactly as it is. The scale is carried across, but it will read as fitted by eye, not measured.",
    es: "Todas las longitudes que dibujaste quedan exactamente igual. La escala se traslada, pero figurará como ajustada a ojo, no medida.",
    fr: "Toutes les longueurs que vous avez tracées restent exactement les mêmes. L'échelle est reportée, mais elle sera indiquée comme ajustée à l'œil, et non mesurée.",
  },
  survey_fit_apply: { en: "Apply fit", es: "Aplicar ajuste", fr: "Appliquer l'ajustement" },
  survey_fit_reset: { en: "Reset", es: "Restablecer", fr: "Réinitialiser" },
  survey_photo_saved_note: {
    en: "The survey photo stays saved with this job. Choosing the grid only hides it on this phone.",
    es: "La foto del plano sigue guardada con este trabajo. Elegir la cuadrícula solo la oculta en este teléfono.",
    fr: "La photo du relevé reste enregistrée avec ce chantier. Choisir la grille ne fait que la masquer sur ce téléphone.",
  },
  survey_show_photo: { en: "Show survey photo", es: "Mostrar la foto del plano", fr: "Afficher la photo du relevé" },
  survey_photo_not_here: {
    en: "This phone cannot show the survey photo right now. It is still saved with the job.",
    es: "Este teléfono no puede mostrar la foto del plano ahora mismo. Sigue guardada con el trabajo.",
    fr: "Ce téléphone ne peut pas afficher la photo du relevé pour le moment. Elle reste enregistrée avec le chantier.",
  },
  survey_fit_open: { en: "Fit photo to drawing", es: "Ajustar la foto al dibujo", fr: "Ajuster la photo au dessin" },
  survey_fit_needs_scale: {
    en: "This photo has no scale yet, so there is nothing to carry across. Use Calibrate first.",
    es: "Esta foto aún no tiene escala, así que no hay nada que trasladar. Usa Calibrar primero.",
    fr: "Cette photo n'a pas encore d'échelle ; il n'y a donc rien à reporter. Utilisez d'abord Calibrer.",
  },
};

// How many arguments the code passes alongside each name (fitText's varargs).
const ARGS = { survey_scale_measured: 1 };

// ---- what the screen asks for ----------------------------------------------
function fitTextCalls(src) {
  const out = [];
  const re = /fitText\(\s*"([A-Za-z0-9_]+)"\s*,\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push({ name: m[1], fallback: m[2].replace(/\\"/g, '"') });
  return out;
}
const calls = fitTextCalls(screen);

// Positional arguments in a format string: the set of N in %N$s / %N$d.
const positional = (s) => new Set([...s.matchAll(/%(\d+)\$[sdf]/g)].map((m) => m[1]));
// Any format conversion at all, numbered or not.
const conversions = (s) => [...s.matchAll(/%(?:\d+\$)?[sdf]/g)].length;

function resourceStrings(dir) {
  const base = new URL(`app/src/main/res/${dir}/`, root);
  const found = {};
  for (const f of readdirSync(base)) {
    if (!/^strings.*\.xml$/.test(f)) continue;
    const text = readFileSync(new URL(f, base), "utf8");
    for (const m of text.matchAll(/<string\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/string>/g)) found[m[1]] = m[2];
  }
  return found;
}

test("every survey control's wording is in the hand-over table, and nothing in the table is unused", () => {
  assert.ok(calls.length >= 10, `expected the screen to carry the survey controls' fitText calls, found ${calls.length}`);
  const used = new Set(calls.map((c) => c.name));
  const proposed = new Set(Object.keys(PROPOSED));
  const unlisted = [...used].filter((n) => !proposed.has(n));
  const unused = [...proposed].filter((n) => !used.has(n));
  assert.deepEqual(unlisted, [], `fitText names the screen uses that the hand-over table does not carry: ${unlisted}`);
  assert.deepEqual(unused, [], `hand-over strings the screen no longer asks for: ${unused}`);
});

test("the English fallback in the code is the English in the table, so a phone before the strings land reads the same sentence", () => {
  const norm = (s) => s.replace(/%\d+\$s/g, "%s");
  for (const { name, fallback } of calls) {
    assert.equal(norm(fallback), norm(PROPOSED[name].en), `fallback for ${name} drifted from the hand-over table`);
  }
});

test("a resource and its fallback take the same arguments, in all three languages", () => {
  for (const [name, t] of Object.entries(PROPOSED)) {
    const want = ARGS[name] ?? 0;
    const call = calls.find((c) => c.name === name);
    assert.ok(call, `no fitText call for ${name}`);
    for (const lang of ["en", "es", "fr"]) {
      assert.equal(conversions(t[lang]), want, `${name} (${lang}) takes ${conversions(t[lang])} arguments, the code passes ${want}`);
      assert.deepEqual([...positional(t[lang])].sort(), Array.from({ length: want }, (_, i) => String(i + 1)), `${name} (${lang}) must use numbered arguments %1$s...`);
      assert.ok(!/%%%/.test(t[lang]), `${name} (${lang}) has a tripled percent`);
    }
    // The Kotlin fallback is formatted with String.format, so it takes the same count.
    assert.equal(conversions(call.fallback), want, `fallback for ${name} takes ${conversions(call.fallback)} arguments, expected ${want}`);
  }
});

test("a string that has landed carries the same arguments as the fallback, in every locale it is in", () => {
  const dirs = { en: "values", es: "values-es", fr: "values-fr" };
  const res = Object.fromEntries(Object.entries(dirs).map(([l, d]) => [l, resourceStrings(d)]));
  for (const name of Object.keys(PROPOSED)) {
    const present = Object.entries(res).filter(([, m]) => name in m).map(([l]) => l);
    if (present.length === 0) continue; // not landed yet: the English fallback is in force
    assert.deepEqual(present.sort(), ["en", "es", "fr"], `${name} is in ${present} but not all three locales -- StringResourceSanityTest will fail on it`);
    const want = ARGS[name] ?? 0;
    for (const l of present) {
      assert.equal(conversions(res[l][name]), want, `${name} (${l}) takes ${conversions(res[l][name])} arguments; the code passes ${want}`);
    }
  }
});

test("none of these names is also referenced as R.string -- that is the reference that fails a build when the resource is missing", () => {
  const code = screen.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const name of Object.keys(PROPOSED)) {
    assert.ok(!code.includes(`R.string.${name}`), `${name} is referenced as R.string.${name}; it must go through fitText until it is in all three locales`);
  }
});

test("XML escaping of the table is safe to paste into strings.xml", () => {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/'/g, "\\'");
  for (const [name, t] of Object.entries(PROPOSED)) {
    for (const lang of ["en", "es", "fr"]) {
      const x = esc(t[lang]);
      assert.ok(!/(?<!\\)'/.test(x), `${name} (${lang}) has an unescaped apostrophe`);
      assert.ok(!/[<>]/.test(x), `${name} (${lang}) has a raw angle bracket`);
      assert.ok(t[lang].trim().length > 0, `${name} (${lang}) is empty`);
    }
  }
});

// ---------------------------------------------------------------------------
// The arithmetic, independently, in float32.
// ---------------------------------------------------------------------------
const f32 = Math.fround;
function feetOf(points, closed, ppf) {
  let total = 0;
  const n = points.length;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    total = f32(total + f32(Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2)));
  }
  return total / ppf;
}

// A small deterministic generator (mulberry32) so the run is reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("fitting leaves the footage where it was: p' = (p - t) / f with calibration' = calibration / f", () => {
  const r = rng(20261001);
  let worst = 0;
  for (let i = 0; i < 5000; i++) {
    const n = 2 + Math.floor(r() * 30);
    const pts = Array.from({ length: n }, () => ({ x: f32(r() * 8000), y: f32(r() * 8000) }));
    const closed = r() < 0.5;
    const cal = f32(1 + r() * 399);
    const f = f32(Math.exp(Math.log(0.1) + r() * Math.log(100)));
    const tx = f32((r() - 0.5) * 20000);
    const ty = f32((r() - 0.5) * 20000);
    const after = pts.map((p) => ({ x: f32((p.x - tx) / f), y: f32((p.y - ty) / f) }));
    const before = feetOf(pts, closed, cal);
    const now = feetOf(after, closed, f32(cal / f));
    worst = Math.max(worst, Math.abs(now - before) / before);
    assert.ok(Math.abs(now - before) <= before * 2e-5 + 0.01, `fit ${i} moved the footage: ${before} -> ${now}`);
  }
  assert.ok(worst < 2e-5, `worst relative error ${worst}`);
});

test("the arithmetic has teeth: the wrong direction (cal * f) is caught", () => {
  const pts = [{ x: 100, y: 100 }, { x: 1100, y: 100 }, { x: 1100, y: 900 }];
  const cal = 12.5;
  const f = 2;
  const after = pts.map((p) => ({ x: p.x / f, y: p.y / f }));
  const right = feetOf(after, false, cal / f);
  const wrong = feetOf(after, false, cal * f);
  const before = feetOf(pts, false, cal);
  assert.ok(Math.abs(right - before) < 1e-3);
  assert.ok(Math.abs(wrong - before) > before * 0.5, "multiplying the calibration instead of dividing it must move the footage a lot");
});

test("zooming about a point keeps the photo under that point where it was", () => {
  // photo pixel q is shown at f*q + t. Zoom by a about c: t' = c + (t - c) * a, f' = f * a.
  const r = rng(7);
  for (let i = 0; i < 2000; i++) {
    const f = 0.2 + r() * 5;
    const t = { x: (r() - 0.5) * 2000, y: (r() - 0.5) * 2000 };
    const c = { x: r() * 4000, y: r() * 3000 };
    const a = 0.3 + r() * 3;
    const q = { x: (c.x - t.x) / f, y: (c.y - t.y) / f };
    const f2 = f * a;
    const t2 = { x: c.x + (t.x - c.x) * a, y: c.y + (t.y - c.y) * a };
    assert.ok(Math.abs(f2 * q.x + t2.x - c.x) < 1e-6 * (1 + Math.abs(c.x)));
    assert.ok(Math.abs(f2 * q.y + t2.y - c.y) < 1e-6 * (1 + Math.abs(c.y)));
  }
});
