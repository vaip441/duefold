import { describe, expect, it } from 'vitest';
import { pageTitle } from './usePageTitle.ts';

describe('page title', () => {
  it('leads with the view and ends with the organization', () => {
    expect(pageTitle('Rooms', 'Northwind Capital')).toBe('Rooms · Northwind Capital');
  });

  it('names the view alone while the organization is unknown', () => {
    expect(pageTitle('Rooms', null)).toBe('Rooms');
  });

  it('does not repeat a view that is the organization name', () => {
    expect(pageTitle('Duefold', 'Duefold')).toBe('Duefold');
  });
});
