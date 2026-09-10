/** Fixed-window counter, kept in memory. Enough to blunt scripted abuse of a free service. */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly limit: number, private readonly windowMs: number) {
    setInterval(() => this.sweep(), windowMs).unref();
  }

  check(key: string): { allowed: boolean; retryAfterSec: number } {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || now >= entry.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, retryAfterSec: 0 };
    }
    entry.count += 1;
    if (entry.count > this.limit) {
      return { allowed: false, retryAfterSec: Math.ceil((entry.resetAt - now) / 1000) };
    }
    return { allowed: true, retryAfterSec: 0 };
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.hits) if (now >= entry.resetAt) this.hits.delete(key);
  }
}
