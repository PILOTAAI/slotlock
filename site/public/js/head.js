// Runs before first paint (render-blocking on purpose; it is tiny and first-party).
// 1. Applies a theme the visitor chose earlier; Starlight's docs read and write the same key.
// 2. Lets the hero play once, only when JavaScript runs, motion is allowed and the page opens at
//    the top. Otherwise the CSS shows the hero in its final state.
(function () {
  var root = document.documentElement;
  try {
    var stored = window.localStorage.getItem('starlight-theme');
    if (stored === 'light' || stored === 'dark') root.setAttribute('data-theme', stored);
  } catch (error) {
    // Storage blocked: follow the system preference.
  }
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reduce && !window.location.hash && (window.scrollY || 0) === 0) {
    root.classList.add('motion');
  }
})();
