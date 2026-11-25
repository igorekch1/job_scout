/** USD per million tokens. Cache writes (5-minute TTL) cost 1.25x the input price. */
export interface Pricing {
  input: number;
  output: number;
  cacheRead: number;
}

/** First-party API list prices, November 2026. Override with `scoring.pricing`. */
const PRICES: Readonly<Record<string, Pricing>> = {
  'claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.2 },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 1 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
};

export interface PricingOverride {
  input: number;
  output: number;
  cache_read?: number;
}

export function pricingFor(model: string, override?: PricingOverride): Pricing | undefined {
  if (override) {
    return {
      input: override.input,
      output: override.output,
      cacheRead: override.cache_read ?? override.input / 10,
    };
  }
  return PRICES[model];
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function costOf(usage: TokenUsage, pricing: Pricing): number {
  const perToken = (perMillion: number) => perMillion / 1_000_000;
  return (
    usage.inputTokens * perToken(pricing.input) +
    usage.cacheWriteTokens * perToken(pricing.input * 1.25) +
    usage.cacheReadTokens * perToken(pricing.cacheRead) +
    usage.outputTokens * perToken(pricing.output)
  );
}
