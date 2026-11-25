import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml, YAMLParseError } from 'yaml';
import type { z } from 'zod';
import { configSchema, type Config } from './schema.js';

/** Thrown for any problem the user can fix by editing config.yaml or .env. */
export class ConfigError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(
      issues.length > 0 ? `${message}\n${issues.map((line) => `  - ${line}`).join('\n')}` : message,
    );
    this.name = 'ConfigError';
  }
}

const formatPath = (path: PropertyKey[]): string =>
  path.reduce<string>((acc, segment) => {
    if (typeof segment === 'number') return `${acc}[${segment}]`;
    return acc ? `${acc}.${String(segment)}` : String(segment);
  }, '');

export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = formatPath(issue.path);
    if (issue.code === 'unrecognized_keys') {
      const keys = issue.keys.map((key) => `"${key}"`).join(', ');
      return `${path || '(root)'}: unknown key${issue.keys.length > 1 ? 's' : ''} ${keys}`;
    }
    return `${path || '(root)'}: ${issue.message}`;
  });
}

/** Validates an already-parsed YAML document. */
export function parseConfig(input: unknown, label = 'config'): Config {
  if (input === null || input === undefined) {
    throw new ConfigError(`${label} is empty`);
  }
  const result = configSchema.safeParse(input);
  if (!result.success) {
    throw new ConfigError(`${label} is invalid:`, formatIssues(result.error));
  }
  return result.data;
}

export function parseConfigYaml(text: string, label = 'config'): Config {
  let document: unknown;
  try {
    document = parseYaml(text);
  } catch (error) {
    if (error instanceof YAMLParseError) {
      throw new ConfigError(`${label} is not valid YAML: ${error.message}`);
    }
    throw error;
  }
  return parseConfig(document, label);
}

export function loadConfig(path = process.env.CONFIG_PATH ?? 'config.yaml'): Config {
  const absolute = resolve(path);
  let text: string;
  try {
    text = readFileSync(absolute, 'utf8');
  } catch {
    throw new ConfigError(
      `Cannot read ${absolute}. Copy config.example.yaml to config.yaml and edit it, or set CONFIG_PATH.`,
    );
  }
  return parseConfigYaml(text, path);
}
