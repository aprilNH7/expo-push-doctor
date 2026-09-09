'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { render } = require('../src/report.js');

test('render shows success when no results fail or warn', () => {
  const out = render([
    { id: 'plugin', title: 'expo-notifications in plugins', status: 'pass', detail: 'Present with mode "production".' },
  ]);
  assert.match(out, /No problems found/);
});

test('render highlights blocking problems', () => {
  const out = render([
    { id: 'plugin', title: 'expo-notifications in plugins', status: 'fail', detail: 'Missing.', fix: 'Add plugin.' },
  ]);
  assert.match(out, /FAIL  expo-notifications in plugins/);
  assert.match(out, /1 blocking problem/);
});

test('render works without color when NO_COLOR is set', () => {
  const previous = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  const out = render([
    { id: 'plugin', title: 'expo-notifications in plugins', status: 'pass', detail: 'ok' },
  ]);
  process.env.NO_COLOR = previous;
  assert.doesNotMatch(out, /\u001b\[/);
});
