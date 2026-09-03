'use strict';

const { goalEntityType } = require('../utils/idGen');

describe('goalEntityType', () => {
  const validCategories = ['monthly', 'quarterly', 'yearly', 'special', 'event', 'pledge', 'installment'];

  test.each(validCategories)('returns the category string for "%s"', (category) => {
    expect(goalEntityType(category)).toBe(category);
  });

  test('throws for an unknown category', () => {
    expect(() => goalEntityType('unknown')).toThrow(/unknown category/i);
    expect(() => goalEntityType('weekly')).toThrow();
    expect(() => goalEntityType('')).toThrow();
  });
});
