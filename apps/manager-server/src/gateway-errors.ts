/**
 * Errors from third-party extensions, from SillyTavern's side of the door.
 *
 * The door adds this script to every SillyTavern page it serves, next to the
 * reply script. It listens for the errors the page raises - thrown, rejected,
 * a script that failed to load, and what extensions write with
 * `console.error` - and passes on only those whose file is an extension's:
 * SillyTavern serves every third-party extension under
 * `/scripts/extensions/third-party/<folder>/`, so the folder in that path is
 * which extension it was.
 *
 * What is sent is the folder, the error's first 300 characters, the file and
 * the line. Never the page, never a chat; and it goes to this door, on this
 * machine, nowhere else. A page says at most ten things about one extension,
 * so a handler that throws on every frame costs ten small requests.
 *
 * Plain ES5-ish JavaScript with no template literals, so it can sit inside
 * this file's template string like the reply script does.
 */

export const ERRORS_SCRIPT_PATH = '/__stm/extension-errors.js';
export const ERRORS_REPORT_PATH = '/__stm/extension-errors';

/** The tag that loads the script, put just before `</head>` with the reply script's. */
export const ERRORS_TAG = `<script src="${ERRORS_SCRIPT_PATH}"></script>`;

export const ERRORS_SCRIPT = `(function () {
  'use strict';
  if (window.__stmExtensionErrors) return;
  window.__stmExtensionErrors = true;
  var PER_EXTENSION = 10;
  // The file, without the line and column a stack adds after it.
  var PATH = /\\/scripts\\/extensions\\/third-party\\/([^\\/?#\\s)]+)\\/[^\\s)'":?#]*/;
  var said = {};
  function folderOf(text) {
    var match = PATH.exec(String(text || ''));
    if (!match) return null;
    try { return { name: decodeURIComponent(match[1]), file: match[0] }; } catch (error) { return null; }
  }
  function send(found, message, line) {
    if (!found || !message) return;
    said[found.name] = (said[found.name] || 0) + 1;
    if (said[found.name] > PER_EXTENSION) return;
    var body = JSON.stringify({ name: found.name, message: String(message).slice(0, 300), file: String(found.file).slice(0, 300), line: typeof line === 'number' ? line : null });
    try {
      fetch('${ERRORS_REPORT_PATH}', { method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'content-type': 'application/json', 'x-stm-tools': '1' }, body: body }).catch(function () {});
    } catch (error) { /* a page that cannot report still works */ }
  }
  function describe(value) {
    if (value && typeof value === 'object' && typeof value.message === 'string') return value.message;
    try { return typeof value === 'string' ? value : JSON.stringify(value); } catch (error) { return String(value); }
  }
  window.addEventListener('error', function (event) {
    var target = event.target;
    // A script or stylesheet that failed to load raises this on the element,
    // with no message and no error.
    if (target && target !== window && (target.src || target.href)) {
      var source = target.src || target.href;
      send(folderOf(source), 'Could not load ' + source, null);
      return;
    }
    var stack = event.error && event.error.stack ? String(event.error.stack) : '';
    send(folderOf(event.filename) || folderOf(stack), event.message || describe(event.error), event.lineno);
  }, true);
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason;
    var stack = reason && reason.stack ? String(reason.stack) : '';
    send(folderOf(stack), describe(reason), null);
  });
  var original = console.error;
  console.error = function () {
    try {
      var parts = [];
      var stack = '';
      for (var index = 0; index < arguments.length; index += 1) {
        var argument = arguments[index];
        if (argument && typeof argument === 'object' && argument.stack && !stack) stack = String(argument.stack);
        parts.push(describe(argument));
      }
      // Who called: the stack of this call names the extension that wrote it,
      // when it was one.
      send(folderOf(stack) || folderOf(new Error().stack), parts.join(' '), null);
    } catch (error) { /* reporting must never break the page's own logging */ }
    return original.apply(this, arguments);
  };
})();
`;

