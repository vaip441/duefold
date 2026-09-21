/**
 * `branding-notifications` module declaration.
 *
 * The only optional module. Owns constrained raster branding and non-auth
 * operational notifications. Omitting it MUST leave no route, migration, job,
 * configuration key, browser chunk, or import edge.
 */

import type { ModuleDeclaration } from '@duefold/composition/contract';

export const moduleDeclaration: ModuleDeclaration = {
  id: 'branding-notifications',
  packageName: '@duefold/branding-notifications',
  requires: ['core-security', 'rooms-documents'],
  routes: [
    {
      id: 'branding.asset.upload',
      method: 'POST',
      path: '/api/branding/assets',
      audience: 'member',
      handler: 'routes/branding-upload.ts',
      handlerFactoryExport: 'createHandler',
    },
    {
      id: 'branding.configuration',
      method: 'POST',
      path: '/api/branding/configuration',
      audience: 'member',
      handler: 'routes/branding-configuration.ts',
      handlerFactoryExport: 'createHandler',
    },
    {
      id: 'branding.support-contact',
      method: 'GET',
      path: '/api/branding/support-contact',
      audience: 'public',
      handler: 'routes/support-contact.ts',
      handlerFactoryExport: 'createHandler',
    },
    {
      id: 'branding.public',
      method: 'GET',
      path: '/api/branding/public',
      audience: 'public',
      handler: 'routes/public-branding.ts',
      handlerFactoryExport: 'createHandler',
    },
    {
      id: 'branding.viewer-introduction',
      method: 'GET',
      path: '/api/viewer/branding/introduction',
      audience: 'viewer',
      handler: 'routes/viewer-introduction.ts',
      handlerFactoryExport: 'createHandler',
    },
    {
      id: 'branding.asset.get',
      method: 'GET',
      path: '/api/branding/assets/:kind',
      audience: 'public',
      handler: 'routes/branding-asset-delivery.ts',
      handlerFactoryExport: 'createHandler',
    },
    {
      id: 'branding.asset.delete',
      method: 'POST',
      path: '/api/branding/assets/delete',
      audience: 'member',
      handler: 'routes/branding-asset-delete.ts',
      handlerFactoryExport: 'createHandler',
    },
  ],
  migrations: [
    { id: '012_branding_assets', file: '012_branding_assets.sql' },
    { id: '015_branding_configuration', file: '015_branding_configuration.sql' },
    { id: '016_public_branding', file: '016_public_branding.sql' },
  ],
  jobs: [
    {
      id: 'branding.image.process',
      handler: 'jobs/branding-image.ts',
      handlerFactoryExport: 'createHandler',
      service: 'worker',
    },
  ],
  config: [],
  browserEntries: [
    {
      id: 'branding-notifications.support-contact',
      source: 'browser/support-contact.ts',
    },
    {
      id: 'branding-notifications.branding',
      source: 'browser/branding.ts',
    },
    {
      /* The room Branding tab and panel. Contributed rather than hardcoded in the
       * application, so omitting this module removes the tab, its label, and the
       * panel from the bundle instead of shipping them inert. */
      id: 'branding-notifications.branding-section',
      source: 'browser/branding-section.tsx',
    },
  ],
};
