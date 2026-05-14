export class Redis {
  constructor(private url: string, private token: string) {}

  private async cmd(...args: unknown[]) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
    })
    const data = await res.json() as { result: unknown }
    return data.result
  }

  async setSession(userId: string, session: object, ttlSeconds = 3600) {
    await this.cmd('SET', `session:${userId}`, JSON.stringify(session), 'EX', ttlSeconds)
  }

  async getSession<T>(userId: string): Promise<T | null> {
    const raw = await this.cmd('GET', `session:${userId}`) as string | null
    return raw ? JSON.parse(raw) as T : null
  }

  async pushMetric(layer: 'peek' | 'mesh' | 'silk', ms: number) {
    await this.cmd('LPUSH', `metrics:${layer}`, ms)
    await this.cmd('LTRIM', `metrics:${layer}`, 0, 999)
  }

  async getMetrics(layer: 'peek' | 'mesh' | 'silk'): Promise<number[]> {
    const raw = await this.cmd('LRANGE', `metrics:${layer}`, 0, 999) as string[]
    return raw.map(Number)
  }

  async get(key: string): Promise<string | null> {
    return await this.cmd('GET', key) as string | null
  }

  async setRaw(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await this.cmd('SET', key, value, 'EX', ttlSeconds)
    } else {
      await this.cmd('SET', key, value)
    }
  }

  async incr(key: string, ttlSeconds?: number): Promise<number> {
    const count = await this.cmd('INCR', key) as number
    if (ttlSeconds && count === 1) {
      await this.cmd('EXPIRE', key, ttlSeconds)
    }
    return count
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length > 0) {
      await this.cmd('DEL', ...keys)
    }
  }

  async checkRateLimit(userId: string, maxPerMinute = 20): Promise<boolean> {
    const key = `ratelimit:${userId}:${Math.floor(Date.now() / 60000)}`
    const count = await this.cmd('INCR', key) as number
    if (count === 1) await this.cmd('EXPIRE', key, 60)
    return count <= maxPerMinute
  }
}