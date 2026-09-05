'use strict';

const { hideConfiguredCategories, HIDDEN_CATEGORIES } = require('../utils/goalVisibility');

describe('hideConfiguredCategories', () => {
  const baseData = {
    contributors: [
      {
        id: 'c1',
        name: 'Alice',
        targetIds: ['gm1', 'gq1'],
        targetAmounts: { gm1: 100, gq1: 300 },
        targetBreakups: { gq1: { jan: 100 } }
      },
      { id: 'c2', name: 'Bob', targetIds: ['gm1'], targetAmounts: { gm1: 100 } }
    ],
    targets: [
      { id: 'gm1', name: 'Monthly', category: 'monthly' },
      { id: 'gq1', name: 'Quarterly', category: 'quarterly' },
      { id: 'gy1', name: 'Yearly', category: 'yearly' }
    ],
    contributions: [
      { id: 'rc1', contributorId: 'c1', targetId: 'gm1', amountPaid: 100 },
      { id: 'rc2', contributorId: 'c1', targetId: 'gq1', amountPaid: 300 }
    ],
    pledges: [
      { id: 'gp1', targetId: 'gy1', name: 'Carol', promisedAmount: 500 }
    ]
  };

  // Every test below passes its own hiddenCategories override rather than
  // relying on the live HIDDEN_CATEGORIES default — that default changes
  // over time as categories get hidden/unhidden for product reasons, and
  // these tests should keep verifying the filtering mechanism itself
  // regardless of what's currently configured as hidden.
  test('removes hidden-category targets', () => {
    const result = hideConfiguredCategories(baseData, ['quarterly']);
    expect(result.targets.map(t => t.id)).toEqual(['gm1', 'gy1']);
  });

  test('strips hidden target references out of contributors', () => {
    const result = hideConfiguredCategories(baseData, ['quarterly']);
    const alice = result.contributors.find(c => c.id === 'c1');
    expect(alice.targetIds).toEqual(['gm1']);
    expect(alice.targetAmounts).toEqual({ gm1: 100 });
    expect(alice.targetBreakups).toEqual({});
  });

  test('drops contributions recorded against a hidden target', () => {
    const result = hideConfiguredCategories(baseData, ['quarterly']);
    expect(result.contributions.map(c => c.id)).toEqual(['rc1']);
  });

  test('leaves pledges against a visible target untouched', () => {
    const result = hideConfiguredCategories(baseData, ['quarterly']);
    expect(result.pledges).toEqual(baseData.pledges);
  });

  test('never mutates the input object', () => {
    const snapshot = JSON.parse(JSON.stringify(baseData));
    hideConfiguredCategories(baseData, ['quarterly']);
    expect(baseData).toEqual(snapshot);
  });

  test('is a no-op when no category is configured as hidden', () => {
    expect(hideConfiguredCategories(baseData, [])).toBe(baseData);
  });

  test('is a no-op when nothing matches a hidden category', () => {
    const noQuarterly = { ...baseData, targets: baseData.targets.filter(t => t.category !== 'quarterly') };
    expect(hideConfiguredCategories(noQuarterly, ['quarterly'])).toBe(noQuarterly);
  });

  test('passes through null/undefined unchanged', () => {
    expect(hideConfiguredCategories(null)).toBe(null);
    expect(hideConfiguredCategories(undefined)).toBe(undefined);
  });

  test('defaults to filtering by the live HIDDEN_CATEGORIES list when no override is passed', () => {
    // Whatever HIDDEN_CATEGORIES currently holds, calling with no second
    // argument should behave identically to passing it explicitly.
    expect(hideConfiguredCategories(baseData)).toEqual(hideConfiguredCategories(baseData, HIDDEN_CATEGORIES));
  });
});
