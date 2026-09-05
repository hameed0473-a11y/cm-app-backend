'use strict';

// Pure helpers under test (copied from rolloverEngine.js to avoid mocking its DB imports)

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

function periodKeyForDate(date, category) {
  if (category === 'yearly') return String(date.getFullYear());
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function nextPeriodKey(key, category) {
  if (category === 'yearly') return String(Number(key) + 1);
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function periodLabel(key, category) {
  if (category === 'yearly') return key;
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

  test('yearly increments by 1', () => {
    expect(nextPeriodKey('2025', 'yearly')).toBe('2026');
  });
});

describe('periodLabel', () => {
  test('monthly: "January 2025"', () => {
    expect(periodLabel('2025-01', 'monthly')).toBe('January 2025');
  });

  test('yearly: "2025"', () => {
    expect(periodLabel('2025', 'yearly')).toBe('2025');
  });
});

describe('isPeriodBefore', () => {
  test('earlier period is before later', () => {
    expect(isPeriodBefore('2025-01', '2025-02')).toBe(true);
    expect(isPeriodBefore('2024', '2025')).toBe(true);
  });

  test('equal periods: returns false', () => {
    expect(isPeriodBefore('2025-01', '2025-01')).toBe(false);
  });

  test('later before earlier: returns false', () => {
    expect(isPeriodBefore('2025-06', '2025-01')).toBe(false);
  });
});
