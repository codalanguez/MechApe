/**
 * theme-boot.js — apply the saved theme before first paint.
 *
 * A classic (non-module) script loaded in <head> so the page never flashes
 * the default palette when another theme is saved. Presets are CSS-variable
 * override blocks keyed on <html data-theme="…"> in style.css; the picker in
 * Preferences writes the same localStorage key ('mechape.theme').
 */
(function () {
  try {
    var t = localStorage.getItem('mechape.theme');
    if (t && t !== 'cyber-deco') document.documentElement.dataset.theme = t;
  } catch (e) { /* storage disabled — default theme stands */ }
})();
