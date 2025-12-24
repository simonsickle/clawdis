import { getReplyFromConfig } from "../auto-reply/reply.js";
import { HEARTBEAT_PROMPT, stripHeartbeatToken } from "../web/auto-reply.js";
import { loadConfig } from "../config/config.js";
import { getChildLogger } from "../logging.js";
import type { RuntimeEnv } from "../runtime.js";
import { createTelegramBot } from "./bot.js";
import { makeProxyFetch } from "./proxy.js";
import { sendMessageTelegram } from "./send.js";
import { startTelegramWebhook } from "./webhook.js";

const telegramHeartbeatLog = getChildLogger({ module: "telegram-heartbeat" });

export type MonitorTelegramOpts = {
  token?: string;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  useWebhook?: boolean;
  webhookPath?: string;
  webhookPort?: number;
  webhookSecret?: string;
  proxyFetch?: typeof fetch;
  webhookUrl?: string;
};

export async function monitorTelegramProvider(opts: MonitorTelegramOpts = {}) {
  const token = (opts.token ?? process.env.TELEGRAM_BOT_TOKEN)?.trim();
  if (!token) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN or telegram.botToken is required for Telegram gateway",
    );
  }

  const cfg = loadConfig();
  const proxyFetch =
    opts.proxyFetch ??
    (cfg.telegram?.proxy
      ? makeProxyFetch(cfg.telegram?.proxy as string)
      : undefined);

  const bot = createTelegramBot({
    token,
    runtime: opts.runtime,
    proxyFetch,
  });

  // Set up heartbeat timer for Telegram
  let heartbeatTimer: NodeJS.Timeout | null = null;
  const heartbeatMinutes = cfg.inbound?.agent?.heartbeatMinutes;
  const allowFrom = cfg.telegram?.allowFrom;

  // Use first allowFrom as heartbeat target (owner's chat)
  const heartbeatTarget = allowFrom?.[0];

  if (heartbeatMinutes && heartbeatMinutes > 0 && heartbeatTarget) {
    const intervalMs = heartbeatMinutes * 60_000;
    const targetChatId = String(heartbeatTarget);

    const runHeartbeat = async () => {
      const started = Date.now();
      try {
        telegramHeartbeatLog.info(
          { target: targetChatId },
          "telegram heartbeat starting",
        );

        const replyResult = await getReplyFromConfig(
          {
            Body: HEARTBEAT_PROMPT,
            From: `telegram:${targetChatId}`,
            To: `telegram:${targetChatId}`,
            MessageSid: `heartbeat-${Date.now()}`,
            Surface: "telegram",
          },
          { isHeartbeat: true },
          cfg,
        );

        const replyPayload = Array.isArray(replyResult)
          ? replyResult[0]
          : replyResult;

        if (!replyPayload?.text) {
          telegramHeartbeatLog.info(
            { durationMs: Date.now() - started },
            "telegram heartbeat ok (empty reply)",
          );
          return;
        }

        const stripped = stripHeartbeatToken(replyPayload.text);
        if (stripped.shouldSkip) {
          telegramHeartbeatLog.info(
            { durationMs: Date.now() - started },
            "telegram heartbeat ok (HEARTBEAT_OK)",
          );
          return;
        }

        // Send the actual message
        const finalText = stripped.text;
        const responsePrefix = cfg.messages?.responsePrefix;
        const textToSend =
          responsePrefix && !finalText.startsWith(responsePrefix)
            ? `${responsePrefix} ${finalText}`
            : finalText;

        await sendMessageTelegram(targetChatId, textToSend, { token });

        telegramHeartbeatLog.info(
          {
            durationMs: Date.now() - started,
            target: targetChatId,
            chars: textToSend.length,
          },
          "telegram heartbeat sent",
        );
      } catch (err) {
        telegramHeartbeatLog.error(
          { error: String(err), durationMs: Date.now() - started },
          "telegram heartbeat failed",
        );
      }
    };

    heartbeatTimer = setInterval(() => {
      void runHeartbeat();
    }, intervalMs);

    telegramHeartbeatLog.info(
      { intervalMinutes: heartbeatMinutes, target: targetChatId },
      "telegram heartbeat timer started",
    );

    // Clean up on abort
    opts.abortSignal?.addEventListener(
      "abort",
      () => {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
      },
      { once: true },
    );
  }

  if (opts.useWebhook) {
    await startTelegramWebhook({
      token,
      path: opts.webhookPath,
      port: opts.webhookPort,
      secret: opts.webhookSecret,
      runtime: opts.runtime as RuntimeEnv,
      fetch: proxyFetch,
      abortSignal: opts.abortSignal,
      publicUrl: opts.webhookUrl,
    });
    return;
  }

  // Long polling
  const stopOnAbort = () => {
    if (opts.abortSignal?.aborted) {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      void bot.stop();
    }
  };
  opts.abortSignal?.addEventListener("abort", stopOnAbort, { once: true });
  try {
    await bot.start();
  } finally {
    opts.abortSignal?.removeEventListener("abort", stopOnAbort);
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }
}
