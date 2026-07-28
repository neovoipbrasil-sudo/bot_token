import { describe, it, expect } from 'vitest';
import { phoneVariants } from './normalize-phone.js';

describe('phoneVariants', () => {
  it('adds the missing 9th digit for an 8-digit mobile local number', () => {
    expect(phoneVariants('556191596979')).toEqual(['556191596979', '5561991596979']);
  });

  it('adds the stripped variant for a 9-digit mobile local number', () => {
    expect(phoneVariants('5561991596979')).toEqual(['5561991596979', '556191596979']);
  });

  it('does not touch an 8-digit landline local number', () => {
    expect(phoneVariants('556121090177')).toEqual(['556121090177']);
  });

  it('strips non-digit formatting before comparing', () => {
    expect(phoneVariants('+55 61 91596-979')).toEqual(['556191596979', '5561991596979']);
  });

  it('leaves numbers without a BR country code untouched', () => {
    expect(phoneVariants('12345678901')).toEqual(['12345678901']);
  });
});
