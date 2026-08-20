'use strict';

/**
 * conformance-report.js
 *
 * Runs test/conformance/*.test.js against a target and says what did not run.
 *
 *   node test/conformance-report.js                              # the mock
 *   node test/conformance-report.js --target ./steam-target.js   # your binding
 *
 *   # from a project that installed this package
 *   node node_modules/steam-inventory-mock/test/conformance-report.js --target ./steam-target.js
 *
 * Node's own runner reports *that* tests were skipped. The interesting part is
 * *why*: which capability the target does not have, and therefore which
 * semantics went unverified on it. That is the entire point of the capability
 * model and it is otherwise buried in 150 individual skip messages spread over
 * fifteen child processes.
 *
 * This reads node:test's public run() event stream — no reporter internals, no
 * dependency. `skip` on a test:pass event carries the reason string that
 * harness.needs() produced, and lib/conformance.js owns both ends of that
 * format so the two cannot drift.
 *
 * Exit code is 1 if anything failed. A skip is not a failure — it is a gap in
 * coverage, reported as one.
 */

const fs = require('node:fs');
const path = require('node:path');
const { run } = require('node:test');

const { TARGET_ENV, SELECT_ENV, CAPABILITY_NAMES, capabilitiesFromSkip } = require('../lib/conformance');

// ─── Arguments ────────────────────────────────────────────────────────────────

// A flag rather than only an environment variable: this is the command a
// consumer types, and `STEAM_MOCK_TARGET=... node ...` is not portable to a
// Windows shell. The environment still works — the plain `node --test` route
// has nowhere else to put it — and the flag simply sets it, before the harness
// is loaded and resolves the target.
function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    else if (arg === '--target' || arg === '-t') options.target = argv[++i];
    else if (arg === '--name' || arg === '-n') options.name = argv[++i];
    else if (arg.startsWith('--target=')) options.target = arg.slice('--target='.length);
    else if (arg.startsWith('--name=')) options.name = arg.slice('--name='.length);
    else return { error: `unknown argument "${arg}"` };
  }
  return options;
}

const USAGE = `Usage: node conformance-report.js [--target <module>] [--name <target>]

  --target, -t   Module defining a conformance target: a path relative to the
                 directory you run from, or an installed package name.
                 Same as ${TARGET_ENV}.
  --name, -n     Which registered target to run, by name. Same as ${SELECT_ENV}.
                 Only needed when the module registers more than one.

With no arguments the suite runs against the built-in mock, which supports
everything and therefore skips nothing.`;

const args = parseArgs(process.argv.slice(2));
if (args.error) {
  console.error(`${args.error}\n\n${USAGE}`);
  process.exit(2);
}
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}
if (args.target) process.env[TARGET_ENV] = args.target;
if (args.name) process.env[SELECT_ENV] = args.name;

// Loaded after the environment is set: the harness resolves and validates the
// target as it loads, so a broken declaration fails here, once and loudly,
// rather than fifteen times inside child processes. A rejected declaration is
// a message to read, not a stack to debug — anything else keeps its trace.
let h;
try {
  h = require('./harness');
} catch (err) {
  if (err.code !== 'ERR_CONFORMANCE_TARGET') throw err;
  console.error(`${err.message}\n`);
  process.exit(2);
}

// ─── Formatting ───────────────────────────────────────────────────────────────

const RULE = '─'.repeat(78);

function pad(text, width) {
  return String(text).padEnd(width, ' ');
}

/** `count` with the right plural, so the summary reads as prose. */
function tests(count) {
  return `${count} test${count === 1 ? '' : 's'}`;
}

function heading(text) {
  console.log(`\n${text}\n${RULE}`);
}

// ─── Run ──────────────────────────────────────────────────────────────────────

const directory = path.join(__dirname, 'conformance');
const files = fs
  .readdirSync(directory)
  .filter(name => name.endsWith('.test.js'))
  .sort()
  .map(name => path.join(directory, name));

const supported = CAPABILITY_NAMES.filter(flag => h.capabilities[flag]);
const absent = CAPABILITY_NAMES.filter(flag => !h.capabilities[flag]);

console.log(RULE);
console.log(`steam-inventory-mock — conformance against target "${h.targetName}"`);
console.log(RULE);
console.log(`  source      ${h.target.source || 'built in (test/harness.js)'}`);
console.log(`  files       ${files.length} in ${directory}`);
console.log(`  supports    ${supported.join(', ') || '(nothing)'}`);
console.log(`  lacks       ${absent.join(', ') || '(nothing)'}`);
if (h.target.shapeVerified) {
  console.log('  contract    assertProviderShape passed at load');
}

const skipped = [];
const failures = [];
const perFile = new Map();
let passed = 0;

function record(file, key) {
  const name = path.basename(file || '(unknown)');
  const counts = perFile.get(name) || { ran: 0, skipped: 0 };
  counts[key] += 1;
  perFile.set(name, counts);
}

// The stream has to be consumed for the run to make progress, so events are
// dispatched off 'data' rather than through per-type listeners.
const stream = run({ files });

stream.on('data', event => {
  if (event.type === 'test:pass') onPass(event.data);
  else if (event.type === 'test:fail') onFail(event.data);
});

function onPass({ name, file, skip, todo }) {
  if (typeof name === 'string' && name.endsWith('.test.js')) return; // the file's own entry
  if (todo) return;
  if (skip === undefined) {
    passed += 1;
    record(file, 'ran');
    return;
  }
  skipped.push({ name, file, reason: typeof skip === 'string' ? skip : '' });
  record(file, 'skipped');
}

function onFail({ name, file, details }) {
  if (typeof name === 'string' && name.endsWith('.test.js')) return;
  failures.push({ name, file, error: details && details.error ? details.error.message : 'failed' });
  record(file, 'ran');
}

stream.on('end', () => {
  const total = passed + failures.length + skipped.length;

  heading(`Result: ${passed} passed, ${failures.length} failed, ${skipped.length} skipped, of ${tests(total)}`);

  if (!h.target.shapeVerified && passed + failures.length === 0) {
    // Every test skipped, so no provider was ever built and assertProviderShape
    // never saw one. Say so rather than let "0 failed" imply otherwise.
    const why = h.target.shapeProbeError ? `\n  create({}) threw: ${h.target.shapeProbeError.message}` : '';
    console.log(`\n  The provider contract itself went unverified: no test ran, so nothing was built.${why}`);
  }

  if (failures.length > 0) {
    console.log('\nFailures — the target diverges from the mock here:');
    for (const failure of failures) {
      console.log(`  ✗ ${failure.name}\n      ${path.basename(failure.file || '')}: ${failure.error.split('\n')[0]}`);
    }
  }

  // ── What went unverified, and why ──
  const byCapability = new Map();
  const otherReasons = new Map();
  for (const entry of skipped) {
    const missing = capabilitiesFromSkip(entry.reason);
    if (missing === null) {
      otherReasons.set(entry.reason, (otherReasons.get(entry.reason) || 0) + 1);
      continue;
    }
    for (const flag of missing) byCapability.set(flag, (byCapability.get(flag) || 0) + 1);
  }

  if (skipped.length === 0) {
    console.log(`\nNothing was skipped: target "${h.targetName}" answered every capability the suite asked for.`);
  } else {
    heading('Unverified semantics, by the capability that gated them');
    const width = Math.max(...[...byCapability.keys()].map(flag => flag.length), 12);
    for (const [flag, count] of [...byCapability].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      console.log(`  ${pad(flag, width)}  ${tests(count)} did not run`);
    }
    for (const [reason, count] of otherReasons) {
      console.log(`  ${pad('(other)', width)}  ${tests(count)}: ${reason}`);
    }
    console.log('\n  A test needing several capabilities is counted under each of them.');

    // A flag the target does not have that nothing skipped for is a hole in the
    // *suite*, not in the target: no test gates on it, so declaring it either
    // way changes nothing and its semantics are covered — if at all — under
    // some other flag.
    const ungated = absent.filter(flag => !byCapability.has(flag));
    if (ungated.length > 0) {
      console.log(`  No test in the suite gates on: ${ungated.join(', ')}.`);
    }

    heading('Coverage by file');
    const fileWidth = Math.max(...[...perFile.keys()].map(name => name.length));
    for (const [name, counts] of [...perFile].sort((a, b) => a[0].localeCompare(b[0]))) {
      const all = counts.ran + counts.skipped;
      const ran = `${counts.ran}/${all} ran`;
      const row = `  ${pad(name, fileWidth)}  `;
      console.log(counts.ran === 0 ? `${row}${pad(ran, 12)}← nothing verified in this file` : `${row}${ran}`);
    }

    console.log(
      [
        '',
        `${tests(skipped.length)} did not run against "${h.targetName}". A skip is not a pass: those semantics`,
        'are unverified on this target. Declaring a capability you do not have would turn',
        'them green without testing anything, which is the one outcome this suite exists',
        'to prevent.',
      ].join('\n')
    );
  }

  process.exitCode = failures.length > 0 ? 1 : 0;
});
