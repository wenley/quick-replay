// Guards the AudioWorklet module path.
//
// This is checked here because nothing else can catch it. The typechecker
// sees only a string; the unit tests never touch the DOM; and the failure it
// produces in a browser is an AbortError with a message — "The operation was
// aborted" — that says nothing about a missing file. It shipped once already.
//
// The trap: audioWorklet.addModule() does NOT resolve relative specifiers the
// way `import` does. `import './x.js'` resolves against the importing
// module's URL, but addModule() resolves against the DOCUMENT's base URL. The
// page is served at /, and the built app lives at /js/, so a bare
// './recorder-worklet.js' asks for /recorder-worklet.js and 404s.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');
const appSource = readFileSync(path.join(srcDir, 'app.ts'), 'utf8');

/** The whole argument list of the addModule call, however it is wrapped. */
function addModuleArgs(): string {
  const match = appSource.match(/audioWorklet\.addModule\(([\s\S]*?)\n?\s*\);/);
  assert.ok(match, 'expected an audioWorklet.addModule(...) call in src/app.ts');
  return match[1];
}

test('addModule resolves the worklet against import.meta.url, not the document', () => {
  const args = addModuleArgs();
  assert.match(
    args,
    /import\.meta\.url/,
    'addModule() resolves relative URLs against the DOCUMENT base URL, not this ' +
    'module. A bare relative specifier resolves to the server root and 404s, ' +
    'which surfaces as an unhelpful AbortError. Wrap it: ' +
    "new URL('./recorder-worklet.js', import.meta.url).href",
  );
});

test('addModule is not passed a bare relative string literal', () => {
  const args = addModuleArgs();
  // A lone quoted specifier as the entire argument is the broken form.
  assert.doesNotMatch(
    args.trim(),
    /^['"]\.{1,2}\//,
    'a bare relative string here resolves against the document, not this module',
  );
});

test('the worklet the app loads has a matching source module', () => {
  const args = addModuleArgs();
  const specifier = args.match(/['"](\.\/[^'"]+\.js)['"]/);
  assert.ok(specifier, 'expected a ./<name>.js specifier inside the addModule call');

  // tsc emits src/<name>.ts to public/js/<name>.js, so a sibling specifier is
  // only correct if the sibling source actually exists.
  const sourceName = path.basename(specifier[1]).replace(/\.js$/, '.ts');
  const sourcePath = path.join(srcDir, sourceName);
  assert.ok(
    existsSync(sourcePath),
    `app.ts loads ${specifier[1]} as a worklet, but ${sourceName} does not exist in src/`,
  );
});
