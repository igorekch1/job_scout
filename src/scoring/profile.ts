import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { ConfigError } from '../config/load.js';

/** Reads the profile file named in config, relative to the config file. */
export function loadProfile(
  profileFile: string,
  configPath = process.env.CONFIG_PATH ?? 'config.yaml',
): string {
  const path = isAbsolute(profileFile)
    ? profileFile
    : resolve(dirname(resolve(configPath)), profileFile);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new ConfigError(
      `Cannot read the profile at ${path}. Copy profile.example.md to profile.md and fill it in, or set application.profile_file.`,
    );
  }
  if (!text.trim()) throw new ConfigError(`The profile at ${path} is empty.`);
  return text;
}
