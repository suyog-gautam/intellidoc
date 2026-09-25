import { describe, expect, it } from 'vitest';
import { deviceBudgets, deviceTier } from '@/lib/browser/deviceProfile';

describe('device budgets', () => {
  it('tiers devices by memory and cores; unknown devices are mid-range', () => {
    expect(deviceTier({ deviceMemory: 8, hardwareConcurrency: 8 })).toBe('high');
    expect(deviceTier({ deviceMemory: 4, hardwareConcurrency: 8 })).toBe('mid');
    expect(deviceTier({ deviceMemory: 2, hardwareConcurrency: 8 })).toBe('low');
    expect(deviceTier({ deviceMemory: 8, hardwareConcurrency: 2 })).toBe('low');
    expect(deviceTier({})).toBe('mid');
  });

  it('shrinks budgets on weaker devices and skips automatic handwriting with Save-Data', () => {
    const high = deviceBudgets({ deviceMemory: 8, hardwareConcurrency: 8 });
    const low = deviceBudgets({ deviceMemory: 1, hardwareConcurrency: 4 });
    expect(low.ocrPixels).toBeLessThan(high.ocrPixels);
    expect(low.imagePixels).toBeLessThan(high.imagePixels);
    expect(low.pageCacheBytes).toBeLessThan(high.pageCacheBytes);
    expect(high.autoHandwriting).toBe(true);
    expect(low.autoHandwriting).toBe(true);
    expect(deviceBudgets({ deviceMemory: 8, hardwareConcurrency: 8, connection: { saveData: true } }).autoHandwriting).toBe(false);
  });
});
