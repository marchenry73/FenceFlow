// A28 -- runs the sign-in health rules that SHIP, not a copy of them.
//
// WHAT THIS IS. SessionManager.kt keeps its sign-in decisions in one pure block
// between two marker comments (LOGIN-HEALTH:BEGIN / LOGIN-HEALTH:END): enums,
// numbers, and functions made only of `if (...) return ...` lines. This module
// reads that block out of the real source file and turns it into JavaScript, so
// a test can call judgeLogin(), loginNotice() and the rest exactly as written in
// the app. A hand-copied model would go on passing after the Kotlin changed --
// the failure this exists to avoid.
//
// WHAT IT REFUSES. It translates a deliberately tiny subset and throws on
// anything else (a `when`, an elvis, a string, a call it does not know). So the
// day somebody rewrites the block into something this cannot read, the tests
// FAIL LOUDLY instead of quietly testing nothing -- the same blind spot as a
// checker that skips what it cannot parse and reports zero problems.
//
// It proves the rules, not that the Kotlin compiles. The compile is the gate's
// job; the one-off differential check recorded in the A28 report ran the real
// Kotlin and this translation side by side over every input and compared them.

export const BEGIN = "// ===== LOGIN-HEALTH:BEGIN =====";
export const END = "// ===== LOGIN-HEALTH:END =====";

/** The pure block, markers excluded. Throws unless both markers appear exactly once. */
export function extractPure(source) {
  const norm = source.replace(/\r\n/g, "\n");
  const count = (needle) => norm.split(needle).length - 1;
  if (count(BEGIN) !== 1) throw new Error(`expected exactly one ${BEGIN}, found ${count(BEGIN)}`);
  if (count(END) !== 1) throw new Error(`expected exactly one ${END}, found ${count(END)}`);
  const a = norm.indexOf(BEGIN) + BEGIN.length;
  const b = norm.indexOf(END);
  if (b < a) throw new Error("the END marker comes before the BEGIN marker");
  return norm.slice(a, b);
}

function stripComments(text) {
  // No string literals exist in the pure block (asserted below), so a plain
  // comment strip cannot eat the inside of one.
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function matchBrace(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") { depth--; if (depth === 0) return i; }
  }
  throw new Error("unbalanced braces in the pure block");
}

const IDENT = /[A-Za-z_][A-Za-z0-9_]*/g;

/** Parse the pure block into a runnable model. */
export function loadModel(pureText) {
  const text = stripComments(pureText);
  if (text.includes('"') || text.includes("'") || text.includes("`")) {
    throw new Error("the pure block contains a string or char literal, which this reader does not translate");
  }

  // ---- enums
  const enums = {};
  for (const m of text.matchAll(/enum class (\w+)\s*\{([^}]*)\}/g)) {
    const members = m[2].split(",").map((s) => s.trim()).filter(Boolean);
    if (members.length === 0) throw new Error(`enum ${m[1]} has no members`);
    enums[m[1]] = members;
  }
  // ---- consts
  const consts = {};
  for (const m of text.matchAll(/const val (\w+)\s*=\s*([0-9_]+)L/g)) consts[m[1]] = Number(m[2].replace(/_/g, ""));

  // ---- functions
  const fns = {};
  const order = [];
  const fnRe = /\bfun (\w+)\(([^)]*)\)\s*:\s*(\w+)\s*\{/g;
  const sigs = [];
  for (const m of text.matchAll(fnRe)) {
    const open = m.index + m[0].length - 1;
    const close = matchBrace(text, open);
    const params = m[2].split(",").map((p) => p.trim()).filter(Boolean).map((p) => {
      const pm = p.match(/^(\w+)\s*:\s*(\w+)$/);
      if (!pm) throw new Error(`${m[1]}: cannot read parameter "${p}"`);
      return { name: pm[1], type: pm[2] };
    });
    sigs.push({ name: m[1], params, ret: m[3], body: text.slice(open + 1, close) });
  }
  if (sigs.length === 0) throw new Error("no functions found in the pure block");
  const fnNames = new Set(sigs.map((s) => s.name));

  const enumRef = new RegExp(`\\b(${Object.keys(enums).join("|")})\\.(\\w+)\\b`, "g");
  const toJs = (expr, ctx) => {
    let js = expr.trim().replace(enumRef, (all, e, v) => {
      if (!enums[e].includes(v)) throw new Error(`${ctx.label}: ${e} has no member ${v}`);
      return JSON.stringify(v);
    });
    js = js.replace(/\b(\d[\d_]*)L\b/g, (all, d) => d.replace(/_/g, ""));
    // Every identifier left must be something we know. A bare word we do not
    // know is Kotlin we did not translate.
    const known = new Set(["true", "false", ...Object.keys(consts), ...fnNames, ...ctx.params]);
    const withoutStrings = js.replace(/"[A-Z_]+"/g, "");
    for (const id of withoutStrings.match(IDENT) ?? []) {
      if (!known.has(id)) throw new Error(`${ctx.label}: do not know "${id}" in \`${expr.trim()}\``);
    }
    if (!/^[A-Za-z0-9_ (),!&|=<>."]+$/.test(js)) throw new Error(`${ctx.label}: unsupported syntax in \`${expr.trim()}\``);
    return js;
  };

  let source = "";
  for (const [k, v] of Object.entries(consts)) source += `const ${k} = ${v};\n`;
  for (const sig of sigs) {
    const ctxBase = { label: sig.name, params: sig.params.map((p) => p.name) };
    const lines = sig.body.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) throw new Error(`${sig.name}: empty body`);
    let js = "";
    let last = null;
    for (const line of lines) {
      let m;
      if ((m = line.match(/^if \((.*)\) return (.+)$/))) {
        js += `  if (${toJs(m[1], ctxBase)}) return ${toJs(m[2], ctxBase)};\n`;
        last = "if";
      } else if ((m = line.match(/^return (.+)$/))) {
        js += `  return ${toJs(m[1], ctxBase)};\n`;
        last = "return";
      } else {
        throw new Error(`${sig.name}: cannot translate the statement \`${line}\` -- the pure block may only hold if-return lines`);
      }
    }
    if (last !== "return") throw new Error(`${sig.name}: the last line must be a bare return, or a path can fall off the end`);
    source += `function ${sig.name}(${sig.params.map((p) => p.name).join(", ")}) {\n${js}}\n`;
    order.push(sig.name);
  }
  source += `return { ${order.join(", ")} };\n`;
  const api = new Function(source)();
  return { enums, consts, sigs, api, jsSource: source };
}

/** The values a parameter of this Kotlin type is tried with, in a stable order. */
export function domainOf(model, type) {
  if (type === "Boolean") return [false, true];
  if (type === "Long") {
    const g = model.consts.LOGIN_UNSURE_GRACE_MS;
    return [0, g - 1, g, g + 1];
  }
  if (model.enums[type]) return model.enums[type];
  throw new Error(`no domain for parameter type ${type}`);
}

/** Every input of one function, as arrays of values, in a stable order. */
export function* allInputs(model, sig) {
  const domains = sig.params.map((p) => domainOf(model, p.type));
  const idx = domains.map(() => 0);
  while (true) {
    yield idx.map((i, k) => domains[k][i]);
    let k = domains.length - 1;
    while (k >= 0) {
      idx[k]++;
      if (idx[k] < domains[k].length) break;
      idx[k] = 0;
      k--;
    }
    if (k < 0) return;
  }
}

/** One table of "fn|args|result" lines over every input of every function. */
export function table(model) {
  const out = [];
  for (const sig of model.sigs) {
    for (const args of allInputs(model, sig)) {
      out.push(`${sig.name}|${args.join("|")}|${model.api[sig.name](...args)}`);
    }
  }
  return out;
}

/** The same enumeration as a Kotlin program, for the one-off differential run. */
export function kotlinHarness(model) {
  const lines = ["package com.fenceestimator.app.cloud", "", "fun main() {", "    val sb = StringBuilder()"];
  const g = model.consts.LOGIN_UNSURE_GRACE_MS;
  for (const sig of model.sigs) {
    const loops = sig.params.map((p, i) => {
      if (p.type === "Boolean") return `listOf(false, true)`;
      if (p.type === "Long") return `listOf(0L, ${g - 1}L, ${g}L, ${g + 1}L)`;
      return `${p.type}.values().toList()`;
    });
    let ind = "    ";
    sig.params.forEach((p, i) => { lines.push(`${ind}for (a${i} in ${loops[i]}) {`); ind += "    "; });
    const call = `${sig.name}(${sig.params.map((p, i) => `a${i}`).join(", ")})`;
    const keys = sig.params.map((p, i) => `\${a${i}}`).join("|");
    lines.push(`${ind}sb.append("${sig.name}|${keys}|\${${call}}\\n")`);
    sig.params.forEach(() => { ind = ind.slice(4); lines.push(`${ind}}`); });
  }
  lines.push("    print(sb)", "}", "");
  return lines.join("\n");
}
