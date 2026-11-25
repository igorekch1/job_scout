import { Api, TelegramClient } from 'telegram';
import { FloodWaitError } from 'telegram/errors/index.js';
import { StringSession } from 'telegram/sessions/index.js';
import { extractLinks, type ChannelPost } from './post.js';

/** Reads recent posts of a public channel. Mocked in tests. */
export interface ChannelReader {
  read(channel: string, limit: number): Promise<ChannelPost[]>;
  close(): Promise<void>;
}

export interface TelegramCredentials {
  apiId: number;
  apiHash: string;
  session: string;
}

/**
 * GramJS client on the user's own account. Read-only: it only fetches channel history.
 * Connects on first use and keeps one connection for the life of the worker.
 */
export class GramJsReader implements ChannelReader {
  private client: TelegramClient | undefined;
  private connecting: Promise<TelegramClient> | undefined;

  constructor(private readonly credentials: TelegramCredentials) {}

  private connect(): Promise<TelegramClient> {
    if (this.client) return Promise.resolve(this.client);
    this.connecting ??= (async () => {
      const client = new TelegramClient(
        new StringSession(this.credentials.session),
        this.credentials.apiId,
        this.credentials.apiHash,
        { connectionRetries: 3, baseLogger: undefined },
      );
      client.setLogLevel('error' as never);
      await client.connect();
      if (!(await client.checkAuthorization())) {
        await client.disconnect();
        throw new Error('TG_SESSION is not authorised. Run the Telegram login again (see README).');
      }
      this.client = client;
      return client;
    })().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  async read(channel: string, limit: number): Promise<ChannelPost[]> {
    const client = await this.connect();
    try {
      const messages = await client.getMessages(channel, { limit });
      return messages
        .filter(
          (message) => typeof message.message === 'string' && message.message.trim().length > 0,
        )
        .map((message) => {
          const entityLinks = (message.entities ?? [])
            .filter(
              (entity): entity is Api.MessageEntityTextUrl =>
                entity instanceof Api.MessageEntityTextUrl,
            )
            .map((entity) => entity.url);
          return {
            id: message.id,
            date: new Date(message.date * 1000),
            text: message.message,
            links: extractLinks(message.message, entityLinks),
          };
        });
    } catch (error) {
      if (error instanceof FloodWaitError) {
        throw new Error(
          `Telegram asked to wait ${error.seconds} s before reading @${channel} again`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.client?.disconnect();
    this.client = undefined;
  }
}
