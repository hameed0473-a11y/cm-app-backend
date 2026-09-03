'use strict';

// Mock supabase before requiring pricing.js, which imports it at the top level.
jest.mock('../lib/supabase', () => ({}));

const { countUniqueSubscribers, getMaxReceipts, getReceiptUsage } = require('../lib/pricing');

describe('countUniqueSubscribers', () => {
  test('deduplicates by mobile across contributors and pledges', () => {
    const contributors = [{ mobile: '1111111111' }, { mobile: '2222222222' }];
    const pledges = [{ mobile: '3333333333' }];
    expect(countUniqueSubscribers(contributors, pledges)).toBe(3);
  });

  test('excludes deleted pledges', () => {
    const contributors = [];
    const pledges = [
      { mobile: '1111111111' },
      { mobile: '2222222222', deleted: true },
    ];
    expect(countUniqueSubscribers(contributors, pledges)).toBe(1);
  });

  test('handles null/undefined arrays gracefully (returns 0)', () => {
    expect(countUniqueSubscribers(null, null)).toBe(0);
    expect(countUniqueSubscribers(undefined, undefined)).toBe(0);
    expect(countUniqueSubscribers(null, undefined)).toBe(0);
  });

  test('a person in both contributors and pledges is counted once', () => {
    const contributors = [{ mobile: '9999999999' }];
    const pledges = [{ mobile: '9999999999' }];
    expect(countUniqueSubscribers(contributors, pledges)).toBe(1);
  });
});

describe('getMaxReceipts', () => {
  test('null paidSubscriberCount returns null (no cap)', () => {
    expect(getMaxReceipts(null, 100)).toBe(null);
    expect(getMaxReceipts(undefined, 100)).toBe(null);
  });

  test('10 subscribers × 100 receipts/sub = 1000', () => {
    expect(getMaxReceipts(10, 100)).toBe(1000);
  });

  test('uses default of 100 if receiptsPerSubscriber is null/undefined', () => {
    expect(getMaxReceipts(5, null)).toBe(500);
    expect(getMaxReceipts(5, undefined)).toBe(500);
  });
});

describe('getReceiptUsage', () => {
  test('max null returns all nulls with isWarning/isBlocked false', () => {
    const result = getReceiptUsage(50, null);
    expect(result.max).toBe(null);
    expect(result.remaining).toBe(null);
    expect(result.percentUsed).toBe(null);
    expect(result.isWarning).toBe(false);
    expect(result.isBlocked).toBe(false);
  });

  test('89 of 100 → isWarning false', () => {
    const result = getReceiptUsage(89, 100);
    expect(result.isWarning).toBe(false);
    expect(result.isBlocked).toBe(false);
  });

  test('90 of 100 → isWarning true, isBlocked false', () => {
    const result = getReceiptUsage(90, 100);
    expect(result.isWarning).toBe(true);
    expect(result.isBlocked).toBe(false);
  });

  test('100 of 100 → isBlocked true', () => {
    const result = getReceiptUsage(100, 100);
    expect(result.isBlocked).toBe(true);
  });

  test('101 of 100 → isBlocked true, remaining 0 (not negative)', () => {
    const result = getReceiptUsage(101, 100);
    expect(result.isBlocked).toBe(true);
    expect(result.remaining).toBe(0);
  });
});
