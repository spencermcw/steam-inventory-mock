'use strict';

/**
 * prepublishOnly guard: refuse to publish to the `latest` dist-tag.
 *
 * `latest` is what a bare `npm install steam-inventory-mock` resolves to, and
 * nothing in this package has been verified against real Steam (see the README's
 * first section). Until a vertical slice has actually been run against a test
 * app, releases belong on `next`, where someone has to ask for them.
 *
 * This is a script rather than `publishConfig.tag` because npm does not honour
 * that field on publish — npm 10.8.2 reports "with tag latest" even with
 * `publishConfig: { tag: 'next' }` set, and only the explicit `--tag` flag
 * takes effect. A field that is quietly ignored is worse than no field, so the
 * check is enforced here instead of trusted there.
 *
 * To publish anyway, once the semantics are measured:
 *   ALLOW_LATEST=1 npm publish --tag latest
 */

const tag = process.env.npm_config_tag || 'latest';

if (tag === 'latest' && process.env.ALLOW_LATEST !== '1') {
  console.error(`
  Refusing to publish to the "latest" dist-tag.

  Nothing in this package has been verified against real Steam, and "latest" is
  what a bare \`npm install\` resolves to. Publish to "next" instead:

      npm run release:next

  If the semantics have since been measured against a real test app and this
  really should become the default install:

      ALLOW_LATEST=1 npm publish --tag latest
  `);
  process.exit(1);
}

console.log(`publishing to dist-tag "${tag}"`);
