/**
 * dsh-plugin-usage-dashboard — Host half
 *
 * Aggregates DeepSeek usage & estimated cost across all sessions and exposes
 * them (plus the account balance with a budget guard) through a same-origin
 * HTTP route `/dsh-usage`. The client bundle polls this route and renders a
 * compact status-bar chip.
 *
 * Data sources (all through dsh services, zero core modification):
 *  - `sessionQuery.listSessions()` — the logical corpus
 *  - `sessionProjections.snapshot()` / `sessionProjectionCache.cachedSnapshot()`
 *    — per-session `tokenUsage`, `sessionStats`, and `title` projections
 *  - `credentials` — the shared `DEEPSEEK_API_KEY` ref for the balance call
 *
 * Cost is an ESTIMATE from DeepSeek's public chat pricing (CNY / 1M tokens):
 * cache-hit input ¥0.5, cache-miss input ¥2, output ¥8. Adjust PRICE below.
 */

export const name = 'usage-dashboard'

export const inject = []

/** Route path answering usage/cost JSON (same origin as the web app). */
const ROUTE_PATH = '/dsh-usage'
/** Credential reference shared with the llm-deepseek adapter. */
const API_KEY_REF = 'DEEPSEEK_API_KEY'
/** In-memory result cache TTL. */
const CACHE_MS = 10000
/** DeepSeek chat pricing estimate, CNY per 1M tokens. */
const PRICE = { uncachedInputPerM: 2, cacheReadPerM: 0.5, outputPerM: 8 }
/** Alert when the account balance (CNY) drops below this value. */
const BALANCE_ALERT_THRESHOLD = 10
/** Per-session rows kept in the detail list; the rest fold into "others". */
const MAX_SESSION_ROWS = 8

export function apply(ctx) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) {
    ctx.logger?.warn?.('[usage-dashboard] webServer service absent; route not registered')
    return
  }

  let cache = { at: 0, value: null }

  async function resolveApiKey() {
    const credentials = ctx.get('credentials')
    if (credentials === undefined) return undefined
    const hit = await credentials.resolve(API_KEY_REF)
    return hit === undefined ? undefined : hit.value
  }

  async function fetchBalance() {
    const apiKey = await resolveApiKey()
    if (!apiKey) return { ok: false, error: '未配置 DeepSeek API Key（DEEPSEEK_API_KEY）' }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    try {
      const response = await fetch('https://api.deepseek.com/user/balance', {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      })
      if (!response.ok) return { ok: false, error: `请求失败 HTTP ${response.status}` }
      const data = await response.json()
      const infos = Array.isArray(data.balance_infos) ? data.balance_infos : []
      return { ok: true, available: data.is_available === true, infos }
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) }
    } finally {
      clearTimeout(timer)
    }
  }

  /** One session's usage projection, tolerating missing units. */
  function readSessionSnapshot(record) {
    const sessions = ctx.get('sessions')
    const projections = ctx.get('sessionProjections')
    const projCache = ctx.get('sessionProjectionCache')

    // Live session: ask the registry for the freshest cut (synchronous).
    const live = sessions === undefined ? undefined : sessions.get(record.header.id)
    if (live !== undefined && projections !== undefined) {
      try {
        return projections.snapshot(live)
      } catch {
        // fall through to the persisted-cache ladder
      }
    }
    // Persisted session: zero-I/O cached read with the record's real header
    // as the identity witness; fall back to a cold read.
    if (projCache !== undefined && record.persisted) {
      try {
        const cut = projCache.cachedSnapshot(record.header)
        if (cut !== undefined) return cut
      } catch {
        // fall through to coldSnapshot
      }
      try {
        return projCache.coldSnapshot(record.header.id)
      } catch {
        // no persisted projections for this session
      }
    }
    return undefined
  }

  async function collectUsage() {
    const sessionQuery = ctx.get('sessionQuery')
    if (sessionQuery === undefined) {
      return { ok: false, error: 'sessionQuery 服务不可用' }
    }
    const records = await sessionQuery.listSessions()
    const totals = { uncachedInput: 0, cacheRead: 0, output: 0, tokens: 0 }
    const perSession = []
    let sessionCount = 0

    for (const record of records) {
      try {
        const snapshot = readSessionSnapshot(record)
        if (snapshot === undefined || snapshot.values === undefined) continue
        const values = snapshot.values
        const usage = values.tokenUsage
        const stats = values.sessionStats
        if (usage === undefined) continue
        const t = usage.totals ?? usage
        const u = typeof t.uncachedInputTokens === 'number' ? t.uncachedInputTokens : 0
        const c = typeof t.cacheReadTokens === 'number' ? t.cacheReadTokens : 0
        const o = typeof t.outputTokens === 'number' ? t.outputTokens : 0
        if (u + c + o <= 0) continue
        const cost = (u / 1e6) * PRICE.uncachedInputPerM + (c / 1e6) * PRICE.cacheReadPerM + (o / 1e6) * PRICE.outputPerM
        totals.uncachedInput += u
        totals.cacheRead += c
        totals.output += o
        sessionCount += 1
        perSession.push({
          id: record.header.id,
          title: typeof values.title === 'string' ? values.title : '(未命名)',
          turns: stats && typeof stats.turns === 'number' ? stats.turns : undefined,
          llmMs: stats && typeof stats.llmMs === 'number' ? stats.llmMs : undefined,
          tokens: u + c + o,
          estimatedCostCny: Math.round(cost * 100) / 100,
        })
      } catch {
        // one broken session must not sink the whole dashboard
      }
    }

    perSession.sort((a, b) => b.estimatedCostCny - a.estimatedCostCny)
    const top = perSession.slice(0, MAX_SESSION_ROWS)
    const rest = perSession.slice(MAX_SESSION_ROWS)
    const restCost = rest.reduce((sum, row) => sum + row.estimatedCostCny, 0)
    if (rest.length > 0) {
      top.push({ id: 'others', title: `其他 ${rest.length} 个会话`, turns: undefined, llmMs: undefined, tokens: undefined, estimatedCostCny: Math.round(restCost * 100) / 100 })
    }

    const totalCny = (totals.uncachedInput / 1e6) * PRICE.uncachedInputPerM
      + (totals.cacheRead / 1e6) * PRICE.cacheReadPerM
      + (totals.output / 1e6) * PRICE.outputPerM

    return {
      ok: true,
      aggregate: {
        sessionCount,
        tokens: {
          uncachedInput: totals.uncachedInput,
          cacheRead: totals.cacheRead,
          output: totals.output,
          total: totals.uncachedInput + totals.cacheRead + totals.output,
        },
        estimatedCostCny: Math.round(totalCny * 100) / 100,
        price: PRICE,
        perSession: top,
      },
    }
  }

  async function handler() {
    const now = Date.now()
    if (cache.value !== null && now - cache.at < CACHE_MS) return cache.value
    let value
    try {
      const [usage, balance] = await Promise.all([collectUsage(), fetchBalance()])
      const totalCny = usage.ok ? usage.aggregate.estimatedCostCny : null
      const balanceCny = balance.ok && balance.infos.length > 0 ? Number(balance.infos[0].total_balance) : undefined
      value = {
        ok: true,
        usage,
        balance,
        budget: {
          alert: balanceCny !== undefined && !Number.isNaN(balanceCny) && balanceCny < BALANCE_ALERT_THRESHOLD,
          thresholdCny: BALANCE_ALERT_THRESHOLD,
          balanceCny,
          estimatedSpendCny: totalCny,
        },
      }
    } catch (error) {
      value = { ok: false, error: String((error && error.message) || error) }
    }
    cache = { at: Date.now(), value }
    return value
  }

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    handler: async (req, res) => {
      try {
        const payload = await handler()
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(payload))
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: String((error && error.message) || error) }))
      }
    },
  }))
}
