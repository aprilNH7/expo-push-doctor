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

test('render pluralizes blocking problems and warnings', () => {
  const problems = render([
    { id: 'plugin', title: 'a', status: 'fail', detail: 'd', fix: 'f' },
    { id: 'bundle-id', title: 'b', status: 'fail', detail: 'd', fix: 'f' },
  ]);
  assert.match(problems, /2 blocking problems/);

  const warnings = render([
    { id: 'project-id', title: 'a', status: 'warn', detail: 'd', fix: 'f' },
    { id: 'expo-go', title: 'b', status: 'warn', detail: 'd', fix: 'f' },
  ]);
  assert.match(warnings, /2 worth a look/);
});

test('render omits fix lines for pass, info and skip statuses', () => {
  const out = render([
    { id: 'plugin', title: 'a', status: 'pass', detail: 'd', fix: 'should not appear' },
    { id: 'native-dirs', title: 'b', status: 'info', detail: 'd', fix: 'should not appear' },
    { id: 'entitlements', title: 'c', status: 'skip', detail: 'd', fix: 'should not appear' },
  ]);
  assert.doesNotMatch(out, /should not appear/);
});

test('render preserves unknown status labels', () => {
  const out = render([
    { id: 'custom', title: 'custom check', status: 'unknown', detail: 'd' },
  ]);
  assert.match(out, /unknown  custom check/);
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
