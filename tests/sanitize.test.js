'use strict';

const { sanitize } = require('../utils/sanitize');

describe('sanitize', () => {
  test.each(['<', '>', '"', "'", '%', ';', '(', ')', '&', '+'])(
    'strips %s from the string',
    (char) => {
      expect(sanitize(`hello${char}world`)).toBe('helloworld');
    }
  );

  test('leaves clean alphanumeric strings unchanged', () => {
    expect(sanitize('hello123')).toBe('hello123');
    expect(sanitize('AbCdEf')).toBe('AbCdEf');
  });

  test('leaves non-string values unchanged', () => {
    expect(sanitize(42)).toBe(42);
    expect(sanitize(null)).toBe(null);
    expect(sanitize(undefined)).toBe(undefined);
  });

  test('trims leading/trailing whitespace', () => {
    expect(sanitize('  hello  ')).toBe('hello');
    expect(sanitize('\t test \n')).toBe('test');
  });
});
