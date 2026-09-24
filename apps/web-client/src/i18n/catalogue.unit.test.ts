/**
 * Message catalogue hygiene.
 *
 * Two properties, both of which a reviewer cannot check by eye once the catalogue is
 * five hundred keys long:
 *
 * 1. THE CATALOGUE CARRIES NO OPTIONAL MODULE'S COPY. A key belonging to an omitted
 *    module would ship in every bundle, so the module's absence would rest on
 *    whatever code happened not to read it rather than on the key being gone.
 *    Invariant 17 is about artifacts, and a string is an artifact.
 * 2. EVERY KEY IS USED, AND EVERY USED KEY EXISTS. An unused key is copy nobody
 *    reviewed for a surface that may not exist; a missing key is a crash in a state
 *    that is rarely reached, which is exactly where failure copy lives.
 */

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { messages } from './en.ts';

const KEYS = Object.keys(messages);

/** Every `translate('key')` occurrence in client source. */
function usedKeys(): ReadonlySet<string> {
  const listed = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', 'apps/web-client/src'],
    { encoding: 'utf8' },
  )
    .split('\n')
    /* `--others` lists untracked files and `--cached` still lists deleted ones, so
       existence is checked rather than assumed. */
    .filter((path) => /\.tsx?$/u.test(path) && !path.endsWith('/en.ts') && existsSync(path));
  const used = new Set<string>();
  for (const path of listed) {
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(/translate\(\s*'([^']+)'/gu)) {
      const key = match[1];
      if (key !== undefined) used.add(key);
    }
    /* Keys reached through a lookup table are named as bare literals in a
     * `Record<..., MessageKey>`, so they are collected from those maps too. */
    for (const match of source.matchAll(/'((?:[a-z][\w.]*\.)[\w.]+)'/gu)) {
      const key = match[1];
      if (key !== undefined && key in messages) used.add(key);
    }
    /* Template keys such as `rooms.state.${state}.explain`. */
    for (const match of source.matchAll(/translate\(\s*`([^`]+)`/gu)) {
      const template = match[1];
      if (template === undefined) continue;
      const pattern = new RegExp(
        `^${template.replace(/\$\{[^}]+\}/gu, '[^.]+').replace(/\./gu, '\\.')}$`,
        'u',
      );
      for (const key of KEYS) if (pattern.test(key)) used.add(key);
    }
  }
  /* `translateCount` reaches a key's `.one` form whenever it reaches the key. */
  for (const key of [...used]) if (`${key}.one` in messages) used.add(`${key}.one`);
  return used;
}

describe('optional module copy', () => {
  it('carries no branding copy, which belongs to the module that owns it', () => {
    const branding = KEYS.filter((key) => key.startsWith('branding.'));
    expect(branding).toStrictEqual([]);
  });

  it('names no optional module and no composition state', () => {
    const values = Object.values(messages).join('\n');
    for (const forbidden of [
      'branding-notifications',
      'core-security',
      'rooms-documents',
      'participants-access',
      'manifest',
      'module',
    ])
      expect(values.toLowerCase(), forbidden).not.toContain(forbidden);
  });
});

describe('every key is reachable', () => {
  it('holds no key that no surface reads', () => {
    const used = usedKeys();
    expect(KEYS.filter((key) => !used.has(key))).toStrictEqual([]);
  });
});

describe('copy discipline', () => {
  it('shows no internal code, identifier, or provider detail', () => {
    const values = Object.values(messages).join('\n');
    expect(values).not.toMatch(/SQLSTATE|correlation|42501|23505|object key|s3:\/\//iu);
  });

  it('makes no DRM claim about screenshots or browser workarounds', () => {
    // Deterrence is not prevention, and the interface must not say otherwise.
    const values = Object.values(messages).join('\n').toLowerCase();
    expect(values).not.toMatch(/prevent(s|ed)? (screenshot|copying|printing)/u);
    expect(values).not.toMatch(/cannot be (screenshotted|copied)/u);
  });

  it('never describes an invitation as access already held', () => {
    /*
     * An invited person has never signed in and holds nothing. Copy that read as
     * though they did would claim access that does not exist.
     */
    expect(messages['members.state.invited']).toContain('not yet signed in');
    expect(messages['members.state.invitedHelp']).toContain('no access yet');
  });

  it('states that a privilege change signs the member out', () => {
    // The member learns about it by being signed out, so the administrator has to be
    // told before causing it.
    for (const key of [
      'members.role.signOutWarning',
      'members.assign.signOutWarning',
      'members.transfer.consequence',
    ] as const)
      expect(messages[key].toLowerCase(), key).toMatch(
        /signs? .*out of every device|signed out of every device/u,
      );
  });

  it('reports a completed ownership transfer as a transfer, not an auth error', () => {
    const ended = messages['members.transfer.sessionEnded'].toLowerCase();
    expect(ended).toContain('transferred');
    expect(ended).toContain('signed out');
    expect(ended).not.toMatch(/error|failed|could not/u);
  });
});
