import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { MemberIdentity } from '../../../core-security/src/authorization.ts';
import { imageSchema as schema, createImageHandler } from './member-preview.ts';
export { schema };
export function createHandler(runtime: WebRuntime, identity: MemberIdentity) {
  return createImageHandler(runtime, identity);
}
