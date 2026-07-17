import { describe, it, expect } from 'vitest';
import { createRateLimiter } from './message-rate-limiter.js';

describe('message-rate-limiter', () => {
  it('allows messages under the per-user limit', () => {
    const limiter = createRateLimiter({ perUserLimit: 2, globalLimit: 100 });
    expect(limiter.checkAndConsume('user-1').allowed).toBe(true);
    expect(limiter.checkAndConsume('user-1').allowed).toBe(true);
  });

  it('blocks a user that exceeds the per-user limit, without touching other users', () => {
    const limiter = createRateLimiter({ perUserLimit: 2, globalLimit: 100 });
    limiter.checkAndConsume('user-1');
    limiter.checkAndConsume('user-1');
    const third = limiter.checkAndConsume('user-1');
    expect(third).toEqual({ allowed: false, scope: 'user' });
    expect(limiter.checkAndConsume('user-2').allowed).toBe(true);
  });

  it('blocks everyone once the global limit is hit, even if no single user exceeded their own limit', () => {
    const limiter = createRateLimiter({ perUserLimit: 20, globalLimit: 2 });
    limiter.checkAndConsume('user-1');
    limiter.checkAndConsume('user-2');
    const third = limiter.checkAndConsume('user-3');
    expect(third).toEqual({ allowed: false, scope: 'global' });
  });

  it('resets the per-user window after windowMs elapses', () => {
    let currentTime = 1000;
    const limiter = createRateLimiter({ perUserLimit: 1, globalLimit: 100, windowMs: 60_000, now: () => currentTime });
    expect(limiter.checkAndConsume('user-1').allowed).toBe(true);
    expect(limiter.checkAndConsume('user-1').allowed).toBe(false);
    currentTime += 60_001;
    expect(limiter.checkAndConsume('user-1').allowed).toBe(true);
  });
});
