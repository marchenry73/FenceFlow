// The 3D quote page's stage overlays: nothing may paint over the imagery
// credit or the badge at phone width.
//
// WHY THIS EXISTS. From the owner's own photo of the live page on a 390px
// Android phone: "YOUR FENCE · 3D PREVIEW" was painted underneath the "TURN
// THE FENCE TO MATCH" panel, and the drag hint sat on top of the imagery
// credit. Every overlay carried its own absolute offset -- hint 70px up,
// credit 48px up -- and those offsets assumed the credit was one line. It
// is one line on a desktop and three on a phone, which is exactly why nobody
// saw it on a desktop. Measured at 390px before the fix: the turn panel was
// 265px of a 362px stage, so the 145px badge at the left could not fit
// beside it in any language (158px in French).
//
// THE RULE NOW. The overlays live in two columns that stack in flow:
//   #stageTop   badge, "remove the old fence", turn panel
//   #stageFoot  drag hint over the imagery credit
// Whatever is above sits above however many lines it takes, so no overlay
// has a `bottom:` that assumes a line count. At phone width the turn panel
// takes the whole top row, the old-fence button drops under it, and the
// badge -- a caption, when the header above the stage already says "your
// fence quote" -- gives way while the panel is up (#stage.has-map). The
// credit is the county's licence condition: it may be restyled or moved,
// never hidden.
//
// This file pins the STRUCTURE the layout depends on, which is what a
// stylesheet edit can quietly undo. The actual pixels were checked in a
// browser at 390px, 320px and desktop width when this landed; a static test
// cannot see pixels, and says so rather than pretending.
//
//   node --test tests/a39-overlap-stage-labels.test.mjs   (no network, no writes)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const PAGE = "website/quote.html";
const src = readFileSync(new URL("../" + PAGE, import.meta.url), "utf8");

/** The text of one `<style>` block. */
const style = (() => {
  const a = src.indexOf("<style>"), b = src.indexOf("</style>");
  assert.ok(a !== -1 && b > a, `no <style> block in ${PAGE}`);
  return src.slice(a, b);
})();

/** Body of the first `@media (max-width:560px)` block, by brace matching. */
const phoneCss = (() => {
  const at = style.indexOf("@media (max-width:560px)");
  assert.notEqual(at, -1, "the phone media query is gone; everything below assumes 560px is the phone breakpoint");
  let depth = 0;
  for (let j = style.indexOf("{", at); j < style.length; j++) {
    if (style[j] === "{") depth++;
    else if (style[j] === "}") { depth--; if (!depth) return style.slice(at, j + 1); }
  }
  throw new Error("unbalanced media block");
})();
const desktopCss = style.replace(phoneCss, "");

/**
 * Every declaration block for a selector, as `prop:value` strings. The
 * selector must be the WHOLE selector of its rule (start of line or after a
 * `}`), so asking for `#stageBadge` does not also read `#stage.has-map
 * #stageBadge` -- the first draft did, and reported the scoped phone rule as
 * an unconditional one.
 */
const rulesFor = (css, selector) => {
  const out = [];
  const re = new RegExp("(^|[}\\n])[ \\t]*" + selector.replace(/[.#>*]/g, "\\$&") + "[ \\t]*\\{([^}]*)\\}", "g");
  let m;
  while ((m = re.exec(css))) out.push(...m[2].split(";").map((s) => s.replace(/\s+/g, "").toLowerCase()).filter(Boolean));
  return out;
};

/** The element with this id, as its opening tag plus the raw inner HTML of its parent chain is not needed: just the tag. */
const tagOf = (id) => {
  const m = src.match(new RegExp("<(\\w+)\\s+id=\"" + id + "\"[^>]*>"));
  assert.ok(m, `no element with id="${id}" in ${PAGE}`);
  return m[0];
};

/** The innerHTML of a div by id, brace-matched on <div>/</div>. */
const divInner = (id) => {
  const open = src.indexOf('<div id="' + id + '"');
  assert.notEqual(open, -1, `no <div id="${id}"> in ${PAGE}`);
  let depth = 0, i = open;
  const re = /<div\b|<\/div>/g;
  re.lastIndex = open;
  let m;
  while ((m = re.exec(src))) {
    if (m[0] === "<div") depth++; else depth--;
    if (!depth) return src.slice(src.indexOf(">", open) + 1, m.index);
  }
  throw new Error("unbalanced div " + id);
};

test("positive control: the page still has the stage, its overlays and the satellite hook", () => {
  for (const id of ["stage", "stageTop", "stageFoot", "stageBadge", "oldFenceBtn", "rotCtl", "stageHint", "mapCred", "imageryCredit", "viewCtl"]) tagOf(id);
  assert.ok(src.includes("window.__fence.attachSatellite="), "attachSatellite is gone; the has-map check below would pass vacuously");
  // And the probe itself has teeth: a selector that is not in the stylesheet yields nothing.
  assert.deepEqual(rulesFor(style, "#noSuchThing"), []);
  assert.ok(rulesFor(desktopCss, "#stage").length > 0, "rulesFor cannot read the stylesheet it is about to judge");
});

test("the hint sits ABOVE the credit in one flow column, so a three-line credit pushes it up instead of under", () => {
  const foot = divInner("stageFoot");
  const hint = foot.indexOf('id="stageHint"'), cred = foot.indexOf('id="mapCred"');
  assert.ok(hint !== -1 && cred !== -1, "the hint and the credit must both live inside #stageFoot");
  assert.ok(hint < cred, "the hint must come before the credit: the column stacks top to bottom and the credit is the caption nearest the photo");
  const foot_ = rulesFor(desktopCss, "#stageFoot");
  assert.ok(foot_.includes("position:absolute"), "#stageFoot must be positioned on the stage");
  assert.ok(foot_.includes("display:flex") && foot_.includes("flex-direction:column"), "#stageFoot must be a flex column; that is the whole fix");
});

test("no overlay carries the absolute offset that assumed a line count", () => {
  for (const sel of ["#stageHint", "#mapCred", "#stageBadge", "#oldFenceBtn"]) {
    const all = [...rulesFor(desktopCss, sel), ...rulesFor(phoneCss, sel)];
    assert.ok(!all.some((r) => /^(bottom|top):/.test(r)), `${sel} has a bottom/top offset again (${all.filter((r) => /^(bottom|top):/.test(r))}); at 390px that put the hint on top of the credit`);
    assert.ok(!all.includes("position:absolute"), `${sel} is absolutely positioned again; it must stack in its column`);
  }
  // Inline positioning is the same bug by another route.
  for (const id of ["stageHint", "mapCred", "stageBadge", "oldFenceBtn", "rotCtl"]) {
    assert.doesNotMatch(tagOf(id), /style="[^"]*(position|bottom|top)\s*:/, `#${id} is positioned inline; the stylesheet columns cannot override that`);
  }
});

test("at phone width the turn panel takes the top row and the badge gives way only while a map is up", () => {
  const rot = rulesFor(phoneCss, "#rotCtl");
  assert.ok(rot.includes("position:static") && rot.includes("width:100%"), "#rotCtl must drop into the column at full width at phone width: 265px of a 362px stage leaves no room beside it");
  assert.ok(rot.includes("order:-1"), "#rotCtl must be the FIRST row at phone width, so the old-fence button lands under it, not under the panel");
  const top = divInner("stageTop");
  for (const id of ["stageBadge", "oldFenceBtn", "rotCtl"]) assert.ok(top.includes('id="' + id + '"'), `#${id} must live inside #stageTop`);
  // The badge hides only under .has-map, only at phone width.
  assert.ok(rulesFor(phoneCss, "#stage.has-map #stageBadge").includes("display:none"), "the phone rule hiding the badge while the panel is up is gone");
  assert.deepEqual(rulesFor(desktopCss, "#stage.has-map #stageBadge"), [], "the badge must stay on a desktop, where it fits beside the panel");
  assert.ok(!rulesFor(phoneCss, "#stageBadge").includes("display:none"), "the badge must not be hidden unconditionally: with no map there is no panel to make room for");
  // And the class is set where the panel is shown, by the satellite code.
  const at = src.indexOf("window.__fence.attachSatellite=");
  const body = src.slice(at, src.indexOf("window.__fence.renderOnce", at));
  assert.ok(body.includes("stage.classList.add('has-map')"), "attachSatellite no longer marks the stage; the badge would sit under the panel again");
  assert.ok(body.indexOf("getElementById('rotCtl').style.display=''") < body.indexOf("stage.classList.add('has-map')"), "the class belongs with the line that shows the panel");
});

test("the imagery credit is never hidden -- the county licence requires it", () => {
  for (const css of [desktopCss, phoneCss]) {
    for (const sel of ["#mapCred", "#imageryCredit", "#stageFoot", "#stage.has-map #mapCred"]) {
      const r = rulesFor(css, sel);
      assert.ok(!r.some((x) => /^(display:none|visibility:hidden|opacity:0$|font-size:0)/.test(x)), `${sel} is hidden by the stylesheet (${r})`);
    }
  }
  // The only display:none on the credit is the inline one attachSatellite clears when imagery arrives.
  assert.match(tagOf("mapCred"), /style="display:none"/, "the credit starts hidden until there is imagery to credit");
  assert.ok(src.includes("document.getElementById('mapCred').style.display=''"), "attachSatellite no longer reveals the credit");
  // Legible: the phone rule may restyle it but not shrink it below what shipped.
  const px = (css) => { const m = rulesFor(css, "#mapCred").find((r) => r.startsWith("font-size:")); return m ? parseFloat(m.slice(10)) : null; };
  assert.ok(px(desktopCss) >= 9.5, "the credit got smaller than the 9.5px that shipped");
  assert.ok(px(phoneCss) === null || px(phoneCss) >= 9.5, "the phone rule shrinks the credit");
});
