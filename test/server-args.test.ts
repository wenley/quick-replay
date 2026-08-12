import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, contentTypeFor } from '../server.ts';

describe('parseArgs', () => {
  test('defaults when no args given', () => {
    assert.deepEqual(parseArgs([]), { max: 300, port: 8080 });
  });

  test('explicit flags: --max then --port', () => {
    assert.deepEqual(parseArgs(['--max', '60', '--port', '3000']), { max: 60, port: 3000 });
  });

  test('explicit flags: --port then --max', () => {
    assert.deepEqual(parseArgs(['--port', '3000', '--max', '60']), { max: 60, port: 3000 });
  });

  test('only --max given, --port keeps default', () => {
    assert.deepEqual(parseArgs(['--max', '120']), { max: 120, port: 8080 });
  });

  test('only --port given, --max keeps default', () => {
    assert.deepEqual(parseArgs(['--port', '9090']), { max: 300, port: 9090 });
  });

  test('rejects non-numeric --max', () => {
    assert.throws(() => parseArgs(['--max', 'abc']), /positive finite number/);
  });

  test('rejects non-numeric --port', () => {
    assert.throws(() => parseArgs(['--port', 'abc']), /positive finite number/);
  });

  test('rejects zero', () => {
    assert.throws(() => parseArgs(['--max', '0']), /positive finite number/);
  });

  test('rejects negative', () => {
    assert.throws(() => parseArgs(['--max', '-5']), /positive finite number/);
  });

  test('rejects --max above the 1800s limit', () => {
    assert.throws(() => parseArgs(['--max', '1801']), /1800/);
  });

  test('accepts exactly 1800 (boundary)', () => {
    assert.deepEqual(parseArgs(['--max', '1800']), { max: 1800, port: 8080 });
  });

  test('rejects a flag given without a value', () => {
    assert.throws(() => parseArgs(['--max']), /requires a value/);
  });

  test('rejects a flag whose "value" is actually the next flag', () => {
    assert.throws(() => parseArgs(['--max', '--port', '3000']), /requires a value/);
  });

  test('rejects unknown flags', () => {
    assert.throws(() => parseArgs(['--bogus', '5']), /Unknown flag/);
  });

  test('rejects an out-of-range --port', () => {
    assert.throws(() => parseArgs(['--port', '99999']), /between 1 and 65535/);
  });

  test('rejects a non-integer --port', () => {
    assert.throws(() => parseArgs(['--port', '8080.5']), /integer/);
  });

  test('accepts port 65535 (boundary)', () => {
    assert.deepEqual(parseArgs(['--port', '65535']), { max: 300, port: 65535 });
  });
});

describe('contentTypeFor', () => {
  test('.js MUST return text/javascript (module + AudioWorklet loading depend on this)', () => {
    assert.equal(contentTypeFor('app.js'), 'text/javascript');
  });

  test('.html returns text/html with charset', () => {
    assert.equal(contentTypeFor('index.html'), 'text/html; charset=utf-8');
  });

  test('.css returns text/css', () => {
    assert.equal(contentTypeFor('style.css'), 'text/css');
  });

  test('.json returns application/json', () => {
    assert.equal(contentTypeFor('data.json'), 'application/json');
  });

  test('.ico returns image/x-icon', () => {
    assert.equal(contentTypeFor('favicon.ico'), 'image/x-icon');
  });

  test('unknown extension falls back to application/octet-stream', () => {
    assert.equal(contentTypeFor('archive.tar.gz'), 'application/octet-stream');
  });
});
