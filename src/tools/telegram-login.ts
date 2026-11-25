/**
 * One-time login for the Telegram channel reader. Signs in with YOUR account and prints a
 * session string to put in .env as TG_SESSION. Run: pnpm tg:login
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH?.trim();
if (!Number.isInteger(apiId) || apiId <= 0 || !apiHash) {
  console.error(
    'Set TG_API_ID and TG_API_HASH first (create them at https://my.telegram.org/apps).',
  );
  process.exit(1);
}

const prompt = createInterface({ input: stdin, output: stdout });
const ask = (question: string) => prompt.question(question);

console.log(
  [
    'This signs in to Telegram with YOUR account to read channels you list in config.yaml.',
    'The session string printed at the end gives full access to the account: keep it secret,',
    'store it only in .env, and revoke it in Telegram (Settings → Devices) if it leaks.',
    '',
  ].join('\n'),
);

const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 3 });
await client.start({
  phoneNumber: () => ask('Phone number (international format): '),
  phoneCode: () => ask('Login code from Telegram: '),
  password: () => ask('Two-step verification password (empty if none): '),
  onError: (error) => console.error(error.message),
});
const session = client.session.save() as unknown as string;
console.log('\nAdd this line to .env:\n');
console.log(`TG_SESSION=${session}\n`);
await client.disconnect();
prompt.close();
process.exit(0);
