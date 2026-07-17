export function createRateLimiter({ perUserLimit = 20, globalLimit = 200, windowMs = 60_000, now = () => Date.now() } = {}) {
  const userCounters = new Map();
  let globalCounter = { count: 0, windowStart: now() };

  function resetIfExpired(counter) {
    const t = now();
    if (t - counter.windowStart >= windowMs) {
      counter.count = 0;
      counter.windowStart = t;
    }
    return counter;
  }

  return {
    checkAndConsume(userId) {
      resetIfExpired(globalCounter);

      let user = userCounters.get(userId);
      if (!user) {
        user = { count: 0, windowStart: now() };
        userCounters.set(userId, user);
      }
      resetIfExpired(user);

      if (user.count >= perUserLimit) return { allowed: false, scope: 'user' };
      if (globalCounter.count >= globalLimit) return { allowed: false, scope: 'global' };

      user.count += 1;
      globalCounter.count += 1;
      return { allowed: true };
    },
  };
}
