/*
 * Boot guard — a CLASSIC script, deliberately not a module.
 *
 * When the page is opened straight from disk, browsers refuse to load ES
 * modules, so js/main.js never executes. Without this file the page would sit
 * on "Loading…" forever with nothing to explain why. A classic script still
 * runs under file://, so it can detect the situation and say so.
 *
 * It also watches for the module failing to boot for any other reason
 * (missing folder, wrong MIME type, JavaScript error) and surfaces a real
 * diagnostic instead of an indefinite spinner.
 */
(function () {
  var NL = String.fromCharCode(10);

  function fail(title, message, detailLines) {
    var loading = document.getElementById('stateLoading');
    var error = document.getElementById('stateError');
    var grid = document.getElementById('cardGrid');
    var foot = document.getElementById('resultsFoot');
    var count = document.getElementById('resultCount');

    if (loading) loading.hidden = true;
    if (grid) grid.hidden = true;
    if (foot) foot.hidden = true;
    if (count) count.textContent = 'Unavailable';
    if (!error) return;

    error.hidden = false;
    var t = document.getElementById('errorTitle');
    var m = document.getElementById('errorText');
    var d = document.getElementById('diagPanel');
    if (t) t.textContent = title;
    if (m) m.textContent = message;
    if (d && detailLines) d.textContent = detailLines.join(NL);
  }

  window.__directoryFail = fail;

  if (location.protocol === 'file:') {
    fail(
      'This page needs a local web server',
      'Browsers block scripts and data files when a page is opened directly from disk. Start a static server in this folder, then reload.',
      [
        'Detected protocol: file:',
        '',
        'Run this inside the Healthcare_Directory folder,',
        'then open the address it prints:',
        '',
        '    python serve.py',
        '',
        'Any other static server works too:',
        '',
        '    npx serve .',
        '    php -S localhost:8080',
        '',
        'Avoid "python -m http.server": it speaks HTTP/1.0 with no',
        'keep-alive, which can stall the 5 MB data download.',
      ]
    );
    return;
  }

  window.addEventListener('load', function () {
    setTimeout(function () {
      // Only fire when the module never executed at all. A slow load is not a
      // failure — main.js sets __directoryBooting the moment it runs, and the
      // loading state shows real progress while the data streams in.
      if (window.__directoryBooted || window.__directoryBooting) return;
      fail(
        'The directory could not start',
        'The application script did not run. Open the browser console for the underlying error.',
        [
          'js/main.js never executed (no boot signal within 20s of page load).',
          '',
          'Most common causes:',
          '  - the js/ folder was not copied with the package',
          '  - the server is not serving .js with a JavaScript MIME type',
          '  - a JavaScript error occurred (see the Console tab)',
        ]
      );
    }, 20000);
  });
})();
