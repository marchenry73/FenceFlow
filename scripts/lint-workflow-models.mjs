// Refuse a Workflow script whose agent() calls do not name a model.
//
// An omitted `model` is not a default -- it silently inherits the session
// model, which is the most expensive choice, made without deciding to make it.
// March has had to point this out seven times. The written rule ("read back
// every agent() call before launching") plainly does not survive contact with
// writing a script, so this is the same check as a command that can be run.
//
//   node scripts/lint-workflow-models.mjs <workflow-script.js>
//
// Exit 0 = every agent() names a model. Non-zero = the count that do not.
//
// It also warns on two things that cost him money in the same way: a script
// that could spawn a very large number of agents, and `effort: 'high'` left on
// a cheap stage, which buys top-tier thinking time on a model chosen to be
// cheap.
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/lint-workflow-models.mjs <workflow-script.js>");
  process.exit(2);
}
const src = readFileSync(file, "utf8");

/** Every `agent(` call site, with the options object that follows its prompt. */
function agentCalls(s) {
  const out = [];
  const re = /\bagent\s*\(/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    // Walk to the matching close paren, tracking nesting and strings, so a
    // paren inside a prompt does not end the call early.
    let depth = 0, i = m.index + m[0].length - 1, quote = null, prev = "";
    for (; i < s.length; i++) {
      const c = s[i];
      if (quote) {
        if (c === quote && prev !== "\\") quote = null;
      } else if (c === '"' || c === "'" || c === "`") {
        quote = c;
      } else if (c === "(") depth++;
      else if (c === ")") { depth--; if (depth === 0) break; }
      prev = c;
    }
    const body = s.slice(m.index, i + 1);
    const line = s.slice(0, m.index).split("\n").length;
    out.push({ line, body });
  }
  return out;
}

const calls = agentCalls(src);
if (!calls.length) {
  console.log("no agent() calls found -- nothing to check");
  process.exit(0);
}

const missing = [];
const cheapWithHighEffort = [];
for (const c of calls) {
  // `model: d.model` counts: the routing is on the dimension rather than
  // inline, which is the shape a pipeline wants.
  if (!/\bmodel\s*:/.test(c.body)) missing.push(c);
  if (/\bmodel\s*:\s*['"](haiku|sonnet)['"]/.test(c.body) &&
      /\beffort\s*:\s*['"](high|xhigh|max)['"]/.test(c.body)) {
    cheapWithHighEffort.push(c);
  }
}

for (const c of missing) {
  const first = c.body.split("\n")[0].slice(0, 100);
  console.log(`  MISSING MODEL  line ${c.line}: ${first}`);
}
for (const c of cheapWithHighEffort) {
  console.log(`  WARN  line ${c.line}: a cheap model with high effort -- top-tier thinking time on a model picked to be cheap`);
}

// A rough ceiling on how many agents this could spawn, from the obvious
// fan-out shapes. Not exact, and deliberately noisy rather than silent.
const fanouts = [...src.matchAll(/\b(parallel|pipeline)\s*\(/g)].length;
if (fanouts >= 3) {
  console.log(`  WARN  ${fanouts} fan-out call(s): check the agent count against what is already proven by tests before launching`);
}

console.log(`\n${missing.length === 0 ? "PASS" : "FAIL"}  ${calls.length - missing.length}/${calls.length} agent() calls name a model`);
process.exit(Math.min(255, missing.length));
