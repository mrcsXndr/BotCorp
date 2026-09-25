/* Cockpit theme: light by default, dark when the OS asks for it, or the
   viewer's own pick ('light' | 'dark' | 'auto'), remembered in localStorage,
   which may be unavailable. Loaded in <head> so the first paint is already in
   the right theme. The tokens themselves live in index.html (see DESIGN.md). */
(function () {
  'use strict';
  var KEY = 'cockpit.theme';
  function get() {
    try { var t = localStorage.getItem(KEY); return t === 'light' || t === 'dark' ? t : 'auto'; } catch (e) { return 'auto'; }
  }
  function apply(t) {
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
  }
  apply(get());
  globalThis.CockpitTheme = {
    get: get,
    set: function (t) { try { localStorage.setItem(KEY, t); } catch (e) {} apply(t); },
  };
})();
