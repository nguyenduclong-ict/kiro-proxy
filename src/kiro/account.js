import { KIRO } from '../config.js';

function headers(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    TokenType: 'API_KEY',
    Accept: 'application/json',
    'User-Agent': KIRO.userAgent,
    'X-Amz-User-Agent': KIRO.userAgent,
  };
}

async function getJson(url, apiKey) {
  const res = await fetch(url, { headers: headers(apiKey), signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return JSON.parse(text);
}

const parseMaybe = (v) => {
  if (typeof v !== 'string') return v ?? null;
  try { return JSON.parse(v); } catch { return null; }
};

export async function listModels(apiKey) {
  const models = [];
  let nextToken = null;
  for (let page = 0; page < 5; page++) {
    const qs = new URLSearchParams({ origin: 'AI_EDITOR', ...(nextToken ? { nextToken } : {}) });
    const data = await getJson(`${KIRO.qHost}/ListAvailableModels?${qs}`, apiKey);
    for (const m of data.models || []) {
      const limits = parseMaybe(m.tokenLimits) || {};
      models.push({
        id: m.modelId,
        name: m.modelName || m.modelId,
        description: m.description || '',
        contextWindow: Number(limits.maxInputTokens) || null,
        maxOutput: Number(limits.maxOutputTokens) || null,
        rateMultiplier: Number(m.rateMultiplier) || 1,
        promptCaching: parseMaybe(m.promptCaching)?.supportsPromptCaching ?? null,
      });
    }
    nextToken = data.nextToken;
    if (!nextToken) break;
  }
  return models;
}

export async function getUsage(apiKey) {
  const qs = new URLSearchParams({ origin: 'AI_EDITOR', resourceType: 'AGENTIC_REQUEST' });
  const data = await getJson(`${KIRO.qHost}/getUsageLimits?${qs}`, apiKey);
  const b = (data.usageBreakdownList || []).find((x) => x.resourceType === 'CREDIT') || data.usageBreakdownList?.[0] || {};
  const used = Number(b.currentUsageWithPrecision ?? b.currentUsage ?? 0);
  const limit = Number(b.usageLimitWithPrecision ?? b.usageLimit ?? 0);
  const overage = data.overageConfiguration?.overageStatus || null;
  return {
    used,
    limit,
    overageStatus: overage,
    overageCap: Number(b.overageCapWithPrecision ?? b.overageCap ?? 0) || null,
    currentOverages: Number(b.currentOveragesWithPrecision ?? 0),
    nextReset: (Number(b.nextDateReset ?? data.nextDateReset) || 0) * 1000 || null,
    plan: data.subscriptionInfo?.subscriptionTitle || null,
    exhausted: limit > 0 && used >= limit && overage !== 'ENABLED',
  };
}
