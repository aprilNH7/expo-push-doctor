'use strict';

const { FAIL, WARN, PASS, INFO, SKIP } = require('./checks.js');

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s);

const MARK = {
  [PASS]: () => c('32', 'PASS'),
  [FAIL]: () => c('31', 'FAIL'),
  [WARN]: () => c('33', 'WARN'),
  [INFO]: () => c('36', 'INFO'),
  [SKIP]: () => c('90', 'SKIP'),
};

function wrap(text, width, indent) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (line && (line + ' ' + w).length > width) {
      lines.push(line);
      line = w;
    } else {
      line = line ? line + ' ' + w : w;
    }
  }
  if (line) lines.push(line);
  return lines.map((l, i) => (i === 0 ? l : indent + l)).join('\n');
}

function render(results) {
  const width = Math.min(process.stdout.columns || 80, 100);
  const indent = ' '.repeat(7);
  const out = [];

  out.push('');
  out.push(c('1', 'expo-push-doctor') + c('90', '  iOS push notification diagnosis'));
  out.push('');

  for (const r of results) {
    out.push(`${MARK[r.status] ? MARK[r.status]() : r.status}  ${c('1', r.title)}`);
    out.push(indent + c('90', wrap(r.detail, width - 8, indent)));
    if (r.fix && (r.status === FAIL || r.status === WARN)) {
      out.push(indent + c('36', '-> ') + wrap(r.fix, width - 11, indent + '   '));
    }
    out.push('');
  }

  const fails = results.filter((r) => r.status === FAIL);
  const warns = results.filter((r) => r.status === WARN);

  if (fails.length) {
    out.push(
      c('31', `${fails.length} blocking problem${fails.length > 1 ? 's' : ''}.`) +
        ' Push cannot work until fixed.'
    );
    // The single most common misunderstanding, so it is worth repeating here.
    if (fails.some((f) => f.id === 'plugin' || f.id === 'entitlements')) {
      out.push(
        c('90', 'Entitlements are compiled into the binary. A new native build is required - eas update will not fix it.')
      );
    }
  } else if (warns.length) {
    out.push(c('33', `No blocking problems, ${warns.length} worth a look.`));
  } else {
    out.push(c('32', 'No problems found.') + ' If push still fails, the cause is server-side or in your token handling.');
  }
  out.push('');

  return out.join('\n');
}

module.exports = { render };
