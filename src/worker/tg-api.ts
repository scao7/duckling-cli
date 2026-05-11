/**
 * Telegram Bot API client for the Worker.
 *
 * Plain async functions, no EventEmitter, no polling — Workers don't host
 * long-running listeners. Incoming TG updates arrive via the /tg-webhook
 * route (see worker.ts), so this file is outbound-only.
 */

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export type InlineKeyboard = InlineKeyboardButton[][];

interface ApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

export interface SendOptions {
  silent?: boolean;
  keyboard?: InlineKeyboard;
  parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML';
}

export interface BotMe {
  id: number;
  username: string;
  first_name: string;
}

export class TgApi {
  private apiBase: string;

  constructor(botToken: string) {
    this.apiBase = `https://api.telegram.org/bot${botToken}`;
  }

  async getMe(): Promise<BotMe> {
    return this.call<BotMe>('getMe', {});
  }

  async sendMessage(
    chatId: string,
    text: string,
    opts: SendOptions = {},
  ): Promise<number> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
      disable_notification: opts.silent === true,
    };
    if (opts.parseMode) body.parse_mode = opts.parseMode;
    if (opts.keyboard) body.reply_markup = { inline_keyboard: opts.keyboard };
    const msg = await this.call<{ message_id: number }>('sendMessage', body);
    return msg.message_id;
  }

  async editMessage(
    chatId: string,
    messageId: number,
    text: string,
    opts: { keyboard?: InlineKeyboard; parseMode?: SendOptions['parseMode'] } = {},
  ): Promise<void> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text,
    };
    if (opts.parseMode) body.parse_mode = opts.parseMode;
    if (opts.keyboard) body.reply_markup = { inline_keyboard: opts.keyboard };
    await this.call<{ message_id: number }>('editMessageText', body);
  }

  async deleteMessage(chatId: string, messageId: number): Promise<void> {
    await this.call<boolean>('deleteMessage', { chat_id: chatId, message_id: messageId });
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    const body: Record<string, unknown> = { callback_query_id: callbackQueryId };
    if (text) body.text = text;
    await this.call<boolean>('answerCallbackQuery', body);
  }

  /**
   * Show the "…is typing" indicator in the chat for ~5 seconds. Any actual
   * sendMessage cancels it implicitly, so we just fire-and-forget at the
   * points where we know the SDK is about to produce output. Cosmetic-only:
   * swallow errors so a flaky typing call never breaks the surrounding flow.
   */
  async sendChatAction(
    chatId: string,
    action: 'typing' | 'upload_photo' | 'upload_document' = 'typing',
  ): Promise<void> {
    try {
      await this.call<boolean>('sendChatAction', { chat_id: chatId, action });
    } catch (e) {
      console.warn('sendChatAction failed:', e instanceof Error ? e.message : e);
    }
  }

  async setWebhook(url: string, secretToken?: string): Promise<void> {
    const body: Record<string, unknown> = {
      url,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true,
    };
    if (secretToken) body.secret_token = secretToken;
    await this.call<boolean>('setWebhook', body);
  }

  async deleteWebhook(): Promise<void> {
    await this.call<boolean>('deleteWebhook', { drop_pending_updates: true });
  }

  /**
   * Register the bot's slash commands so they appear in Telegram's clickable
   * "/" menu (left of the input box). Idempotent — calling with the same list
   * is a no-op.
   */
  async setMyCommands(
    commands: { command: string; description: string }[],
  ): Promise<void> {
    await this.call<boolean>('setMyCommands', { commands });
  }

  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.apiBase}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as ApiResponse<T>;
    if (!data.ok || data.result === undefined) {
      throw new Error(
        `telegram ${method} failed: ${data.error_code ?? '?'} ${data.description ?? ''}`,
      );
    }
    return data.result;
  }
}

// No inline keyboards in the pty-relay world. If a future feature needs them,
// add the keyboard-builders + callback decoders back here.
