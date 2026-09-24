/**
 * `read_mail_identity()` is core's extension point for the sender of required mail.
 *
 * Core defines it and the optional branding module replaces it. That override is only
 * safe while nothing else touches the function: a later migration redefining it would
 * silently drop the configured sender name, or run before the override and be lost.
 */

import { globSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CORE = 'modules/core-security/migrations/031_mail_identity.sql';
const BRANDING = 'modules/branding-notifications/migrations/032_branding_administration.sql';

describe('mail identity extension point', () => {
  it('is defined by core and replaced only by the branding module', () => {
    const naming = globSync('modules/*/migrations/*.sql')
      .filter((path) => readFileSync(path, 'utf8').includes('read_mail_identity'))
      .sort();
    expect(naming).toStrictEqual([BRANDING, CORE]);
    expect(readFileSync(CORE, 'utf8')).toMatch(/CREATE FUNCTION read_mail_identity\(\)/u);
    expect(readFileSync(BRANDING, 'utf8')).toMatch(
      /CREATE OR REPLACE FUNCTION read_mail_identity\(\)/u,
    );
  });
});
