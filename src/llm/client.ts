import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { z } from 'zod';
import type { TokenUsage } from './pricing.js';

export interface LlmRequest<T extends z.ZodType> {
  /** Instructions that change rarely; sent first so they are cached. */
  instructions: string;
  /** Large stable context such as the user profile; the cache breakpoint sits after it. */
  context: string;
  /** The per-call part. */
  prompt: string;
  schema: T;
  maxTokens?: number;
  /** Overrides the client's default effort for this call. */
  effort?: 'low' | 'medium' | 'high';
}

export interface LlmResult<T> {
  /** Parsed output, or null when the model declined or returned nothing usable. */
  output: T | null;
  refused: boolean;
  /** Model that produced the answer (differs from the requested one after a fallback). */
  model: string;
  usage: TokenUsage;
}

/** What the scorer and the application drafter need from an LLM. Mocked in tests. */
export interface LlmClient {
  generate<T extends z.ZodType>(request: LlmRequest<T>): Promise<LlmResult<z.infer<T>>>;
}

export interface AnthropicLlmOptions {
  model: string;
  effort: 'low' | 'medium' | 'high';
  /** Falls back to the SDK's own credential lookup when unset. */
  apiKey?: string;
}

/**
 * Claude through the official SDK: structured output validated against a Zod schema, the
 * stable prefix cached, and a server-side fallback when the model declines.
 */
export class AnthropicLlm implements LlmClient {
  private readonly client: Anthropic;

  constructor(private readonly options: AnthropicLlmOptions) {
    this.client = new Anthropic(options.apiKey ? { apiKey: options.apiKey } : {});
  }

  async generate<T extends z.ZodType>(request: LlmRequest<T>): Promise<LlmResult<z.infer<T>>> {
    const response = await this.client.beta.messages.parse({
      model: this.options.model,
      max_tokens: request.maxTokens ?? 8000,
      betas: ['server-side-fallback-2026-07-01'],
      // On a policy decline the API retries on Anthropic's recommended model for that category.
      fallbacks: 'default',
      output_config: {
        effort: request.effort ?? this.options.effort,
        format: betaZodOutputFormat(request.schema),
      },
      system: [
        { type: 'text', text: request.instructions },
        { type: 'text', text: request.context, cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: request.prompt }],
    });

    const usage: TokenUsage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
    };
    const refused = response.stop_reason === 'refusal';
    return {
      output: refused ? null : (response.parsed_output ?? null),
      refused,
      model: response.model,
      usage,
    };
  }
}
