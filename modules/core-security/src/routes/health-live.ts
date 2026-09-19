import { Type } from '@sinclair/typebox';
export const schema = {
  response: {
    200: Type.Object({ status: Type.Literal('live') }, { additionalProperties: false }),
  },
};
/** Liveness proves only process health. */
export function handler(): { status: 'live' } {
  return { status: 'live' };
}
