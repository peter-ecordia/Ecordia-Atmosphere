// Light or dark, following the device's setting, before the page is drawn (base.css reads data-theme).
(function () {
  var root = document.documentElement;
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function apply() { root.setAttribute('data-theme', media && media.matches ? 'dark' : 'light'); }
  apply();
  if (media && media.addEventListener) media.addEventListener('change', apply);
})();
