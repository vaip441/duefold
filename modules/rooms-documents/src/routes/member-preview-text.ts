import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { MemberIdentity } from '../../../core-security/src/authorization.ts';
import { textPreviewSchema as schema, createTextHandler } from './member-preview.ts';
export { schema };
export function createHandler(runtime: WebRuntime, identity: MemberIdentity) {
  return createTextHandler(runtime, identity);
}
export function handler(): never {
  throw new Error('member preview text route runtime not initialized');
}
