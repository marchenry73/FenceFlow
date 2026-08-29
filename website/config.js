/*
 * Which backend this copy of the site talks to.
 *
 * Every page used to carry the project URL and publishable key inline, in four
 * different files. That made a dev copy of the site impossible to keep
 * straight: you would change three of them, miss the fourth, and have a page
 * quietly reading and writing the live company's data while the rest of the
 * site sat on dev. One file now, loaded before anything else, and a dev copy
 * differs from the live one by exactly these three lines.
 *
 * The publishable key belongs in public source. It is designed to be public,
 * and Row Level Security in Postgres is what actually keeps one company out of
 * another's data. The service_role key is a different thing entirely and has
 * never been here.
 *
 * A classic script rather than a module on purpose: classic scripts run in
 * parse order, modules are deferred to after the document is parsed. Loading
 * this one first means every page -- module or not -- finds the config already
 * there.
 */
window.FENCEFLOW_CONFIG = {
  ENV: 'prod',
  SUPABASE_URL: 'https://newcrgafcptspmapacrx.supabase.co',
  SUPABASE_KEY: 'sb_publishable_2WmwTcQkUNCRzDCRpNmwWA_s3gxJk3b',
};

/*
 * On a dev copy, say so on the page itself.
 *
 * A dev dashboard is pixel-identical to the live one, which is how somebody
 * ends up refunding a real customer from a test tab. The bar cannot be
 * dismissed and does not appear at all when ENV is 'prod', so the live site is
 * untouched by it.
 */
if (window.FENCEFLOW_CONFIG.ENV !== 'prod') {
  document.addEventListener('DOMContentLoaded', function () {
    var bar = document.createElement('div');
    bar.textContent =
      'DEV ENVIRONMENT — test data only, nothing here reaches a real customer';
    bar.setAttribute('role', 'status');
    bar.style.cssText = [
      'position:fixed', 'left:0', 'right:0', 'top:0', 'z-index:2147483647',
      'background:#b3261e', 'color:#fff', 'font:600 13px/1.4 system-ui,sans-serif',
      'letter-spacing:.04em', 'text-align:center', 'padding:7px 12px',
      'box-shadow:0 2px 8px rgba(0,0,0,.35)', 'pointer-events:none',
    ].join(';');
    document.body.appendChild(bar);
    // Push the page down rather than covering whatever is at the top of it.
    document.body.style.paddingTop =
      (parseFloat(getComputedStyle(document.body).paddingTop) || 0) + 32 + 'px';
  });
}
