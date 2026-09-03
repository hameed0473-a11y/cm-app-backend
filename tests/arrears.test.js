'use strict';

const { getDefaultBreakup, getRemainingBreakup, breakupTotal } = require('../utils/arrears');

describe('getDefaultBreakup', () => {
  test('returns single item with target name and amount', () => {
    const result = getDefaultBreakup({ name: 'Monthly Fund' }, 500);
    expect(result).toEqual([{ label: 'Monthly Fund due', amount: 500 }]);
  });
});

describe('breakupTotal', () => {
  test('sums all amounts', () => {
    expect(breakupTotal([{ label: 'a', amount: 100 }, { label: 'b', amount: 200 }])).toBe(300);
  });

  test('handles negative amounts', () => {
    expect(breakupTotal([{ label: 'a', amount: 500 }, { label: 'credit', amount: -100 }])).toBe(400);
  });

  test('handles all negatives', () => {
    expect(breakupTotal([{ label: 'credit', amount: -50 }])).toBe(-50);
  });
});

describe('getRemainingBreakup', () => {
  test('full payment clears all dues to zero', () => {
    const breakup = [{ label: 'Jan due', amount: 300 }, { label: 'Feb due', amount: 200 }];
    const result = getRemainingBreakup(breakup, 500);
    expect(result.every(i => i.amount === 0)).toBe(true);
  });

  test('partial payment reduces oldest item first', () => {
    const breakup = [{ label: 'Jan due', amount: 300 }, { label: 'Feb due', amount: 200 }];
    const result = getRemainingBreakup(breakup, 100);
    expect(result[0].amount).toBe(200); // Jan reduced from 300 to 200
    expect(result[1].amount).toBe(200); // Feb untouched
  });

  test('overpayment: result is all zeros', () => {
    const breakup = [{ label: 'Jan due', amount: 100 }];
    const result = getRemainingBreakup(breakup, 500);
    expect(result[0].amount).toBe(0);
  });

  test('advance credit is applied after real cash, oldest first', () => {
    // 200 due in Jan, 100 advance credit, pay 50 cash
    const breakup = [
      { label: 'Advance credit', amount: -100 },
      { label: 'Jan due', amount: 200 },
    ];
    const result = getRemainingBreakup(breakup, 50);
    // After cash: Jan = 150; after credit (100): Jan = 50, credit = 0
    const janItem = result.find(i => i.label === 'Jan due');
    const creditItem = result.find(i => i.label === 'Advance credit');
    expect(janItem.amount).toBe(50);
    expect(Math.abs(creditItem.amount)).toBe(0); // credit fully used (-0 === 0)
  });

  test('credit reduces remaining dues, leftover credit stays as negative line', () => {
    // 50 due, 100 credit, 0 cash
    const breakup = [
      { label: 'Advance credit', amount: -100 },
      { label: 'Jan due', amount: 50 },
    ];
    const result = getRemainingBreakup(breakup, 0);
    const creditItem = result.find(i => i.label === 'Advance credit');
    const janItem = result.find(i => i.label === 'Jan due');
    expect(janItem.amount).toBe(0);
    expect(creditItem.amount).toBe(-50); // 50 leftover credit
  });

  test('no credit line: behaves as simple oldest-first reduction', () => {
    const breakup = [
      { label: 'Jan due', amount: 100 },
      { label: 'Feb due', amount: 100 },
    ];
    const result = getRemainingBreakup(breakup, 150);
    expect(result[0].amount).toBe(0);
    expect(result[1].amount).toBe(50);
  });

  test('amounts are rounded to 2 decimal places', () => {
    // Pay 0.001 from a 100.005 due item — remainder should be rounded to 2dp
    const breakup = [{ label: 'Jan due', amount: 100.005 }];
    const result = getRemainingBreakup(breakup, 0.001);
    const decimals = result[0].amount.toString().split('.')[1];
    expect(!decimals || decimals.length <= 2).toBe(true);
  });
});
