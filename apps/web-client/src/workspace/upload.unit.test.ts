/**
 * Upload part planning and transfer sequencing.
 *
 * Progress correctness is the point: a member watching a large upload needs the
 * number to mean bytes the provider acknowledged. These tests assert it advances
 * monotonically, reaches exactly 100, and that a cancelled transfer finalizes
 * nothing.
 */

import { describe, expect, it, vi } from 'vitest';
import { planParts } from '../components/UploadPanel.tsx';
import { transferParts } from './upload.ts';

const MIB = 1024 * 1024;

describe('planParts', () => {
  it('plans one part for a small file and covers the file exactly', () => {
    const plan = planParts(1024);
    expect(plan).toEqual([{ partNumber: 1, size: 1024 }]);
  });

  it('never exceeds the provider part limit, and the sizes sum to the file', () => {
    for (const size of [5 * MIB, 40 * MIB, 600 * MIB, 4096 * MIB]) {
      const plan = planParts(size);
      expect(plan.length, String(size)).toBeLessThanOrEqual(50);
      expect(
        plan.reduce((sum, part) => sum + part.size, 0),
        String(size),
      ).toBe(size);
      // Part numbers are 1-based and contiguous, which the server schema requires.
      expect(plan.map((part) => part.partNumber)).toEqual(plan.map((_, index) => index + 1));
    }
  });

  it('plans nothing for an empty file rather than a zero-sized part', () => {
    expect(planParts(0)).toEqual([]);
  });
});

describe('transferParts', () => {
  function file(size: number): File {
    return new File([new Uint8Array(size)], 'model.pdf', { type: 'application/pdf' });
  }

  it('uploads every part in order and reports progress that ends at 100', async () => {
    const plan = planParts(12 * MIB);
    const intent = {
      intentId: 'i'.repeat(32),
      uploadId: 'upload',
      parts: plan.map((part) => ({
        partNumber: part.partNumber,
        url: `https://storage.invalid/${String(part.partNumber)}`,
      })),
    };
    const seen: number[] = [];
    const uploaded: number[] = [];
    // A fake provider: records the part order and returns an ETag.
    const original = globalThis.XMLHttpRequest;
    globalThis.XMLHttpRequest = fakeXhr(uploaded);
    try {
      const parts = await transferParts({
        file: file(12 * MIB),
        intent,
        plan,
        signal: new AbortController().signal,
        onProgress: (percent) => {
          seen.push(percent);
        },
      });
      expect(parts.map((part) => part.partNumber)).toEqual(plan.map((part) => part.partNumber));
      expect(parts.every((part) => part.etag !== '')).toBe(true);
      // Sequential: the provider saw parts in plan order.
      expect(uploaded).toEqual(plan.map((part) => part.partNumber));
      // Monotonic and complete.
      expect(seen.at(-1)).toBe(100);
      expect([...seen].sort((a, b) => a - b)).toEqual(seen);
    } finally {
      globalThis.XMLHttpRequest = original;
    }
  });

  it('aborts without uploading further parts when cancelled', async () => {
    const plan = planParts(12 * MIB);
    const intent = {
      intentId: 'i'.repeat(32),
      uploadId: 'upload',
      parts: plan.map((part) => ({
        partNumber: part.partNumber,
        url: `https://storage.invalid/${String(part.partNumber)}`,
      })),
    };
    const controller = new AbortController();
    controller.abort();
    await expect(
      transferParts({
        file: file(12 * MIB),
        intent,
        plan,
        signal: controller.signal,
        onProgress: () => undefined,
      }),
    ).rejects.toThrow(/abort/iu);
  });

  it('fails when the intent omits a planned part rather than skipping it silently', async () => {
    const plan = planParts(12 * MIB);
    await expect(
      transferParts({
        file: file(12 * MIB),
        intent: { intentId: 'i'.repeat(32), uploadId: 'upload', parts: [] },
        plan,
        signal: new AbortController().signal,
        onProgress: () => undefined,
      }),
    ).rejects.toThrow();
  });
});

/** Minimal XHR double that acknowledges each PUT with an ETag. */
function fakeXhr(uploaded: number[]): typeof XMLHttpRequest {
  return class {
    public status = 200;
    public upload = { addEventListener: vi.fn() };
    private url = '';
    private listeners = new Map<string, () => void>();
    public open(_method: string, url: string): void {
      this.url = url;
    }
    public addEventListener(event: string, listener: () => void): void {
      this.listeners.set(event, listener);
    }
    public getResponseHeader(): string {
      return '"etag-value"';
    }
    public abort(): void {
      this.listeners.get('abort')?.();
    }
    public send(): void {
      const part = Number(this.url.split('/').pop());
      uploaded.push(part);
      this.listeners.get('load')?.();
    }
  } as unknown as typeof XMLHttpRequest;
}
