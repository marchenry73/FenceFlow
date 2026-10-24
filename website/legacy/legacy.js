/* Legacy Solutions -- page script. No network calls are made by this file. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var yr = $('yr');
  if (yr) yr.textContent = String(new Date().getFullYear());

  /* ---------------------------------------------------------------------
     CONTACT FORM -- NOT CONNECTED
     This deliberately sends nothing. It only tells the visitor so.

     When a backend endpoint exists (see the checklist in index.html above the
     form), replace the body of showNotConnected() with something like the
     commented block below, change the button to type="submit", and remove the
     preview notice. Left commented out on purpose: there is no live endpoint.

       var ENDPOINT = 'https://REPLACE-WITH-REAL-ENDPOINT';
       fetch(ENDPOINT, {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({
           name: $('c_name').value.trim(),
           email: $('c_email').value.trim(),
           business: $('c_biz').value.trim(),
           topic: $('c_topic').value,
           message: $('c_msg').value.trim(),
           website: $('c_web').value            // honeypot; server drops if set
         })
       }).then(...show success / error in #formMsg...);
     --------------------------------------------------------------------- */
  var form = $('contactForm');
  var msg = $('formMsg');

  function showNotConnected() {
    if (!msg) return;
    msg.textContent = 'This form is not connected yet, so nothing was sent. Please check back soon.';
    msg.className = 'msg show';
  }

  if (form) {
    // Belt and braces: a submit event (Enter key, assistive tech) is cancelled.
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      showNotConnected();
    });
    var btn = $('sendBtn');
    if (btn) btn.addEventListener('click', showNotConnected);
  }
})();
