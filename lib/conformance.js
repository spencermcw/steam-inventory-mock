'use strict';

/**
 * conformance.js
 *
 * Target registration for the conformance suite.
 *
 * Everything under test/conformance/ is written against test/harness.js rather
 * than against MockProvider, so the same behavioural suite can be pointed at a
 * real ISteamInventory binding. That claim is only true if the *owner of the
 * binding* can register it, and they cannot: for anyone who installed this
 * package, test/harness.js lives under node_modules and is overwritten on the
 * next install. Editing it is not a path, it is a temporary fork.
 *
 * So targets are registered from outside the package instead. A target is a
 * plain object — no import from this package required to write one:
 *
 *   // steam-target.js, in your project
 *   module.exports = {
 *     name: 'steam',
 *     capabilities: { ... },              // every flag in CAPABILITIES, explicitly
 *     create(options) { return new SteamProvider(options); },
 *   };
 *
 * and named on the command line:
 *
 *   STEAM_MOCK_TARGET=./steam-target.js \
 *     node --test node_modules/steam-inventory-mock/test/conformance/*.test.js
 *
 * A module may also call registerTarget() itself — useful for registering
 * several bindings from one file, or from a --require preload. Requiring this
 * module (never test/harness.js, which resolves the target as it loads and
 * would be half-initialised) is what such a module imports.
 *
 * Validation below is deliberately unforgiving about capability flags. An
 * omitted flag reads as "absent", `needs()` skips every test that wants it,
 * and the suite reports green by not running — the exact drift that has bitten
 * this repo twice. A target that cannot answer a flag is a target that does
 * not know what it supports, so it is refused rather than defaulted.
 */

const path = require('node:path');
const { createRequire } = require('node:module');
const { CAPABILITIES, assertProviderShape } = require('./provider-interface');

// ─── Environment ──────────────────────────────────────────────────────────────

/** Module specifier defining one or more targets; resolved from the caller's cwd. */
const TARGET_ENV = 'STEAM_MOCK_TARGET';
/** Which registered target to run, by name. Predates STEAM_MOCK_TARGET; unchanged. */
const SELECT_ENV = 'STEAM_MOCK_PROVIDER';
/** The target the suite runs against when nothing else is asked for. */
const DEFAULT_TARGET = 'mock';

const CAPABILITY_NAMES = Object.freeze(Object.keys(CAPABILITIES));

const TEMPLATE_HINT =
  'Start from the template at node_modules/steam-inventory-mock/test/example-steam-target.js';

// ─── Registry ─────────────────────────────────────────────────────────────────

/** name -> validated target. Module-scoped: one registry per loaded copy of this package. */
const registry = new Map();

/**
 * The module currently being loaded by loadTargetModule(), used as the default
 * `source` so a target that registers itself is still attributed to the file it
 * came from — which is what every error message and the report header quote.
 */
let loadingSource = null;

function from(source) {
  return source ? ` (from ${source})` : '';
}

/**
 * Every error raised while registering or resolving a target carries this code,
 * so a caller can tell "your target declaration is wrong" — which wants a plain
 * message — from a bug inside the module it loaded, which wants a stack.
 */
function targetError(message) {
  const error = new Error(message);
  error.code = 'ERR_CONFORMANCE_TARGET';
  return error;
}

/**
 * Check a target specification and return the normalised, frozen-capability
 * form the harness uses. Throws with everything wrong in one message: a target
 * is usually being written by someone who has this file open once, not
 * iteratively.
 */
function validateTarget(spec, source) {
  const where = from(source);
  if (spec === null || typeof spec !== 'object') {
    throw targetError(
      `Conformance target${where} must be an object { name, capabilities, create }, got ` +
        `${spec === null ? 'null' : typeof spec}. ${TEMPLATE_HINT}`
    );
  }

  const name = typeof spec.name === 'string' ? spec.name.trim() : '';
  if (name === '') {
    throw targetError(`Conformance target${where} needs a non-empty string \`name\` — it is how ${SELECT_ENV} selects it.`);
  }
  if (typeof spec.create !== 'function') {
    throw targetError(`Conformance target "${name}"${where} needs a \`create(options)\` function returning a provider.`);
  }

  const declared = spec.capabilities;
  if (declared === null || typeof declared !== 'object') {
    throw targetError(
      `Conformance target "${name}"${where} must declare \`capabilities\` as an object answering ` +
        `all ${CAPABILITY_NAMES.length} flags: ${CAPABILITY_NAMES.join(', ')}`
    );
  }

  // Snapshot: the built-in mock target derives its flags through a getter, and
  // the harness hands `capabilities` out to every test file. Read it once.
  const capabilities = { ...declared };
  const unanswered = CAPABILITY_NAMES.filter(flag => !(flag in capabilities));
  const unknown = Object.keys(capabilities).filter(flag => !(flag in CAPABILITIES));
  const notBoolean = CAPABILITY_NAMES.filter(
    flag => flag in capabilities && typeof capabilities[flag] !== 'boolean'
  );

  const problems = [];
  if (unanswered.length > 0) {
    problems.push(`  does not answer: ${unanswered.join(', ')}`);
  }
  if (unknown.length > 0) {
    problems.push(`  declares flags that are not capabilities: ${unknown.join(', ')} (a typo here silently over-skips)`);
  }
  if (notBoolean.length > 0) {
    problems.push(`  answers with something other than true/false: ${notBoolean.join(', ')}`);
  }
  if (problems.length > 0) {
    throw targetError(
      [
        `Conformance target "${name}"${where} has an incomplete capability declaration:`,
        ...problems,
        '',
        'Every flag must be answered explicitly, true or false. An omitted flag reads as',
        'absent, which skips every test that needs it — the suite then reports green by',
        'not running. Declare what your provider cannot do; that is the report.',
        '',
        `Canonical list: ${CAPABILITY_NAMES.join(', ')}`,
        TEMPLATE_HINT,
      ].join('\n')
    );
  }

  return {
    name,
    capabilities: Object.freeze(capabilities),
    create: (options = {}) => spec.create(options),
    source: source || null,
    /** Set once assertProviderShape has been run against a provider this target built. */
    shapeVerified: false,
    /** Why the load-time shape probe could not run, if it could not. See probeShape(). */
    shapeProbeError: null,
  };
}

/** Validate and register a target. Returns the normalised target. */
function registerTarget(spec, source = loadingSource) {
  const target = validateTarget(spec, source);
  const existing = registry.get(target.name);
  if (existing) {
    throw targetError(
      `A conformance target named "${target.name}" is already registered${from(existing.source)}. ` +
        'Give this one a different `name`.'
    );
  }
  registry.set(target.name, target);
  return target;
}

// ─── Provider shape ───────────────────────────────────────────────────────────

/**
 * Run assertProviderShape against a provider this target built, and remember
 * that it passed. A structural failure is reported against the *target*,
 * because that is the thing the person running the suite can fix.
 */
function verifyShape(target, provider) {
  if (provider === null || typeof provider !== 'object') {
    throw targetError(
      `Conformance target "${target.name}"${from(target.source)} create() returned ` +
        `${provider === null ? 'null' : typeof provider}, not a provider.`
    );
  }
  try {
    assertProviderShape(provider);
  } catch (err) {
    throw targetError(
      `Conformance target "${target.name}"${from(target.source)} does not satisfy the provider ` +
        `contract: ${err.message}`
    );
  }
  target.shapeVerified = true;
  target.shapeProbeError = null;
  return true;
}

/**
 * Check the contract at load time by building a provider with no options.
 *
 * Not every target can be constructed that way — the built-in mock refuses to
 * guess a schema, and a real binding may need an appid — so a construction
 * failure is recorded rather than raised, and the first provider the suite
 * actually builds is verified instead (see harness.createProvider). What must
 * never happen is a target running unverified in silence: when neither check
 * has happened, `shapeVerified` stays false and the report says so.
 */
function probeShape(target) {
  if (target.shapeVerified) return target;
  let provider;
  try {
    provider = target.create({});
  } catch (err) {
    target.shapeProbeError = err;
    return target;
  }
  verifyShape(target, provider);
  return target;
}

// ─── Loading a target module ──────────────────────────────────────────────────

/**
 * Load the module named by STEAM_MOCK_TARGET and register what it defines.
 *
 * Resolved from process.cwd(), not from this file: the module belongs to the
 * consumer's project, which is typically several directories away from
 * node_modules/steam-inventory-mock/lib. Relative paths behave the way they do
 * on the command line, and a bare specifier resolves against the consumer's
 * dependencies.
 */
function loadTargetModule(specifier) {
  const fromCwd = createRequire(path.join(process.cwd(), 'steam-inventory-mock-target-loader.js'));
  const request = /^[./]|^[a-zA-Z]:[\\/]/.test(specifier) ? path.resolve(process.cwd(), specifier) : specifier;

  let resolved;
  try {
    resolved = fromCwd.resolve(request);
  } catch (err) {
    // Trim node's "Require stack:", which would otherwise name the synthetic
    // filename createRequire() was anchored to and send the reader nowhere.
    const why = err.message.split('\nRequire stack:')[0];
    throw targetError(
      `${TARGET_ENV}="${specifier}" could not be resolved from ${process.cwd()}: ${why}\n` +
        'Give a path relative to the directory you run from (./steam-target.js) or the name of an installed package.'
    );
  }

  const before = new Set(registry.keys());
  let exported;
  loadingSource = resolved;
  try {
    exported = fromCwd(resolved);
  } finally {
    loadingSource = null;
  }
  const specs = (Array.isArray(exported) ? exported : [exported]).filter(
    spec => spec !== null && typeof spec === 'object' && ('name' in spec || 'create' in spec || 'capabilities' in spec)
  );
  for (const spec of specs) registerTarget(spec, resolved);

  const added = [...registry.keys()].filter(name => !before.has(name));
  if (added.length === 0) {
    throw targetError(
      `${TARGET_ENV}="${specifier}" resolved to ${resolved} but registered no conformance target.\n` +
        'Export a target object — { name, capabilities, create } — an array of them, or call\n' +
        "registerTarget() from the module itself: require('steam-inventory-mock/lib/conformance').\n" +
        TEMPLATE_HINT
    );
  }
  return added;
}

// ─── Resolution ───────────────────────────────────────────────────────────────

function unknownTarget(name, specifier) {
  const known = [...registry.keys()].map(n => `"${n}"`).join(', ');
  const lines = [
    `Unknown ${SELECT_ENV} "${name}" — no conformance target by that name is registered (known: ${known}).`,
  ];
  if (!specifier) {
    lines.push(
      '',
      `Register one by pointing ${TARGET_ENV} at a module in your own project:`,
      `  ${TARGET_ENV}=./steam-target.js ${SELECT_ENV}=${name} \\`,
      '    node --test node_modules/steam-inventory-mock/test/conformance/*.test.js',
      TEMPLATE_HINT
    );
  }
  return targetError(lines.join('\n'));
}

/**
 * The whole selection story, in one place:
 *
 *   nothing set                      -> the built-in mock target
 *   STEAM_MOCK_TARGET                -> load it; if it registers exactly one
 *                                       target, that is the one to run
 *   STEAM_MOCK_PROVIDER              -> pick a registered target by name
 *
 * Ambiguity is refused rather than guessed: a module registering several
 * targets without a name to pick would otherwise silently fall back to the
 * mock and report a green run against the wrong thing.
 */
function resolveTarget(env = process.env) {
  const specifier = (env[TARGET_ENV] || '').trim();
  const loaded = specifier ? loadTargetModule(specifier) : [];
  const requested = (env[SELECT_ENV] || '').trim();

  if (!requested && loaded.length > 1) {
    throw targetError(
      `${TARGET_ENV}="${specifier}" registered ${loaded.length} targets (${loaded.join(', ')}).\n` +
        `Choose one with ${SELECT_ENV}=<name>, or --name <name> if you are running conformance-report.js.`
    );
  }

  const name = requested || (loaded.length === 1 ? loaded[0] : DEFAULT_TARGET);
  const target = registry.get(name);
  if (!target) throw unknownTarget(name, specifier);
  return probeShape(target);
}

// ─── Skip reasons ─────────────────────────────────────────────────────────────

// The reason text is the only channel a skip has: node:test carries it through
// to the reporter and to the `skip` field of a test:pass event, and nothing
// else about *why* a test did not run survives the process boundary. Both the
// producer (harness.needs) and the consumer (test/conformance-report.js) are
// here so the format has one owner.
const SKIP_PREFIX = 'provider "';
const SKIP_SEPARATOR = '" lacks: ';

function skipReason(targetName, missing) {
  return `${SKIP_PREFIX}${targetName}${SKIP_SEPARATOR}${missing.join(', ')}`;
}

/** The capability names behind a skip reason, or null if it was not one of ours. */
function capabilitiesFromSkip(reason) {
  if (typeof reason !== 'string' || !reason.startsWith(SKIP_PREFIX)) return null;
  const at = reason.indexOf(SKIP_SEPARATOR);
  if (at === -1) return null;
  return reason
    .slice(at + SKIP_SEPARATOR.length)
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);
}

module.exports = {
  // Read by test/conformance-report.js
  TARGET_ENV,
  SELECT_ENV,
  CAPABILITY_NAMES,
  capabilitiesFromSkip,
  // Read by test/harness.js
  registerTarget,
  resolveTarget,
  verifyShape,
  skipReason,
};
