'use strict';

// Pure helpers under test (copied from rolloverEngine.js to avoid mocking its DB imports)

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

function periodKeyForDate(date, category) {
  if (category === 'yearly') return String(date.getFullYear());
  if (category === 'quarterly') {
    const quarter = Math.floor(date.getMonth() / 3) + 1;
    return `${date.getFullYear()}-Q${quarter}`;
  }
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function nextPeriodKey(key, category) {
  if (category === 'yearly') return String(Number(key) + 1);
  if (category === 'quarterly') {
    const [y, q] = key.split('-Q').map(Number);
    return q >= 4 ? `${y + 1}-Q1` : `${y}-Q${q + 1}`;
  }
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function periodLabel(key, category) {
  if (category === 'yearly') return key;
  if (category === 'quarterly') {
    const [y, q] = key.split('-Q');
    return `Q${q} ${y}`;
  }
  const [y, m] = key.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

function isPeriodBefore(a, b) {
  return a < b;
}

// -----------------------------------------------------------------------

describe('periodKeyForDate', () => {
  test('monthly: returns YYYY-MM', () => {
    expect(periodKeyForDate(new Date(2025, 0, 15), 'monthly')).toBe('2025-01');
    expect(periodKeyForDate(new Date(2025, 11, 1), 'monthly')).toBe('2025-12');
  });

  test('quarterly Q1: Jan–Mar', () => {
    expect(periodKeyForDate(new Date(2025, 0, 1), 'quarterly')).toBe('2025-Q1');
    expect(periodKeyForDate(new Date(2025, 2, 31), 'quarterly')).toBe('2025-Q1');
  });

  test('quarterly Q2: Apr–Jun', () => {
    expect(periodKeyForDate(new Date(2025, 3, 1), 'quarterly')).toBe('2025-Q2');
    expect(periodKeyForDate(new Date(2025, 5, 30), 'quarterly')).toBe('2025-Q2');
  });

  test('quarterly Q3: Jul–Sep', () => {
    expect(periodKeyForDate(new Date(2025, 6, 1), 'quarterly')).toBe('2025-Q3');
  });

  test('quarterly Q4: Oct–Dec', () => {
    expect(periodKeyForDate(new Date(2025, 9, 1), 'quarterly')).toBe('2025-Q4');
    expect(periodKeyForDate(new Date(2025, 11, 31), 'quarterly')).toBe('2025-Q4');
  });

  test('yearly: returns the year as string', () => {
    expect(periodKeyForDate(new Date(2025, 5, 15), 'yearly')).toBe('2025');
  });
});

describe('nextPeriodKey', () => {
  test('monthly wraps Dec to Jan of next year', () => {
    expect(nextPeriodKey('2025-12', 'monthly')).toBe('2026-01');
  });

  test('monthly mid-year advances correctly', () => {
    expect(nextPeriodKey('2025-03', 'monthly')).toBe('2025-04');
  });

  test('quarterly Q4 wraps to Q1 of next year', () => {
    expect(nextPeriodKey('2025-Q4', 'quarterly')).toBe('2026-Q1');
  });

  test('quarterly Q1 advances to Q2', () => {
    expect(nextPeriodKey('2025-Q1', 'quarterly')).toBe('2025-Q2');
  });

  test('yearly increments by 1', () => {
    expect(nextPeriodKey('2025', 'yearly')).toBe('2026');
  });
});

describe('periodLabel', () => {
  test('monthly: "January 2025"', () => {
    expect(periodLabel('2025-01', 'monthly')).toBe('January 2025');
  });

  test('quarterly: "Q1 2025"', () => {
    expect(periodLabel('2025-Q1', 'quarterly')).toBe('Q1 2025');
  });

  test('yearly: "2025"', () => {
    expect(periodLabel('2025', 'yearly')).toBe('2025');
  });
});

describe('isPeriodBefore', () => {
  test('earlier period is before later', () => {
    expect(isPeriodBefore('2025-01', '2025-02')).toBe(true);
    expect(isPeriodBefore('2024', '2025')).toBe(true);
    expect(isPeriodBefore('2025-Q1', '2025-Q2')).toBe(true);
  });

  test('equal periods: returns false', () => {
    expect(isPeriodBefore('2025-01', '2025-01')).toBe(false);
  });

  test('later before earlier: returns false', () => {
    expect(isPeriodBefore('2025-06', '2025-01')).toBe(false);
  });
});
