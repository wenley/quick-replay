import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeWavBlob } from '../src/wav.ts';

function readAscii(view: DataView, offset: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

test('header markers: RIFF/WAVE/fmt /data at their fixed offsets', async () => {
  const samples = new Float32Array([0, 0.25, -0.25]);
  const blob = encodeWavBlob(samples, 44100);
  const view = new DataView(await blob.arrayBuffer());

  assert.equal(readAscii(view, 0, 4), 'RIFF');
  assert.equal(readAscii(view, 8, 4), 'WAVE');
  assert.equal(readAscii(view, 12, 4), 'fmt ');
  assert.equal(readAscii(view, 36, 4), 'data');
});

test('fmt chunk fields', async () => {
  const samples = new Float32Array([0, 0.1, -0.1, 0.5]);
  const sampleRate = 48000;
  const blob = encodeWavBlob(samples, sampleRate);
  const view = new DataView(await blob.arrayBuffer());

  assert.equal(view.getUint32(16, true), 16); // fmt chunk size
  assert.equal(view.getUint16(20, true), 1); // PCM
  assert.equal(view.getUint16(22, true), 1); // mono
  assert.equal(view.getUint32(24, true), sampleRate);
  assert.equal(view.getUint32(28, true), sampleRate * 2); // byte rate
  assert.equal(view.getUint16(32, true), 2); // block align
  assert.equal(view.getUint16(34, true), 16); // bits per sample
});

test('size fields: RIFF size and data size', async () => {
  const samples = new Float32Array(10).fill(0);
  const blob = encodeWavBlob(samples, 44100);
  const view = new DataView(await blob.arrayBuffer());

  const dataSize = samples.length * 2;
  assert.equal(view.getUint32(4, true), 36 + dataSize);
  assert.equal(view.getUint32(40, true), dataSize);
});

test('blob size and type', async () => {
  const samples = new Float32Array(100).fill(0);
  const blob = encodeWavBlob(samples, 44100);
  assert.equal(blob.size, 44 + samples.length * 2);
  assert.equal(blob.type, 'audio/wav');
});

test('round-trip: known ramp of float samples decodes to expected int16 values', async () => {
  const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
  const blob = encodeWavBlob(samples, 44100);
  const view = new DataView(await blob.arrayBuffer());

  const expected = [0, 16384, -16384, 32767, -32768];
  for (let i = 0; i < expected.length; i++) {
    assert.equal(view.getInt16(44 + i * 2, true), expected[i]);
  }
});

test('clamping: out-of-range samples clamp to int16 extremes', async () => {
  const samples = new Float32Array([2.0, -2.0]);
  const blob = encodeWavBlob(samples, 44100);
  const view = new DataView(await blob.arrayBuffer());

  assert.equal(view.getInt16(44, true), 32767);
  assert.equal(view.getInt16(46, true), -32768);
});

test('asymmetric scaling at the boundary: -1.0 -> -32768, +1.0 -> +32767', async () => {
  const samples = new Float32Array([1.0, -1.0]);
  const blob = encodeWavBlob(samples, 44100);
  const view = new DataView(await blob.arrayBuffer());

  assert.equal(view.getInt16(44, true), 32767);
  assert.equal(view.getInt16(46, true), -32768);
});

test('empty Float32Array produces a valid 44-byte header-only blob', async () => {
  const samples = new Float32Array(0);
  const blob = encodeWavBlob(samples, 44100);
  assert.equal(blob.size, 44);

  const view = new DataView(await blob.arrayBuffer());
  assert.equal(readAscii(view, 0, 4), 'RIFF');
  assert.equal(readAscii(view, 8, 4), 'WAVE');
  assert.equal(view.getUint32(4, true), 36);
  assert.equal(view.getUint32(40, true), 0);
});
