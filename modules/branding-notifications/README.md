# Branding and notifications map

This is the only optional module. It owns constrained branding assets and configuration, public branding reads, support contact presentation, branding image processing, and non-auth operational notification contributions. Omitting it must remove its routes, migrations, jobs, browser code, and configuration from production artifacts.

## Start here

- [Module declaration](src/declaration.ts) — routes, migrations, jobs, and browser entries.
- [Branding capability](src/branding.ts)
- [Routes](src/routes/) — upload, configuration, public delivery, support contact, and viewer introduction.
- [Browser contribution](src/browser/) — optional panel, API, copy, and section registration.
- [Image-processing job](src/jobs/branding-image.ts)
- [Database functions](migrations/)
- [Lifecycle integration test](../../test/integration/branding-lifecycle.test.ts)
- [Composition browser test](../../test/browser/composition.spec.ts)

## Does not own

Authentication mail remains in [core-security](../core-security/README.md). Core UI tokens and visual language remain in [the shipped design record](../../DESIGN.md) and [web-client styles](../../apps/web-client/src/styles/).
