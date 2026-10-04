// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 717982176. See LICENSE for terms and warranty disclaimer.
import { DurableObject } from "cloudflare:workers";

/**
 * Telegram 传话筒机器人（Cloudflare Workers）
 *
 * 需要配置的环境变量 / 绑定（全部通过 Cloudflare 后台或 `wrangler secret put` 设置，切勿写进源码）：
 *   BOT_TOKEN           Telegram Bot Token（secret）
 *   MY_ADMIN_ID         管理员的 Telegram 数字 ID
 *   WEBHOOK_SECRET      自定义随机字符串，setWebhook 时作为 secret_token 传入（secret）
 *   TURNSTILE_SITE_KEY  Cloudflare Turnstile 站点密钥
 *   TURNSTILE_SECRET    Cloudflare Turnstile 私钥（secret）
 *   BOT_KV              KV 命名空间绑定
 *   BOT_STATE           Durable Object 绑定，类名 BotCoordinator（配置见部署说明）
 *   WELCOME_IMAGE       （可选）欢迎图片 URL
 *
 * 安全设置 Webhook：见 docs/DEPLOYMENT.md，使用 npm run set-webhook。
 * 不要把真实 Token 拼到浏览器地址或命令历史中。
 */

const MSG_MAP_TTL = 30 * 24 * 60 * 60; // 消息映射保留 30 天，便于回复较早的消息
const RATE_LIMIT_WINDOW_MS = 3 * 1000;
const RATE_LIMIT_MAX_MESSAGES = 3;
const RECENT_USER_TTL = 30 * 24 * 60 * 60; // 最近 30 天有交流的访客
const ADMIN_NAME_CACHE_TTL = 10 * 60;
const RECEIPT_DELETE_DELAY_MS = 500;
const ACTIVE_TARGET_TTL = 7 * 24 * 60 * 60;
const IMMUNITY_TTL = 180 * 24 * 60 * 60; // 管理员回复过的用户，180 天内授权不会被清理（每次互动刷新）
const BAN_TTL = 30 * 24 * 60 * 60; // 黑名单有效期 30 天
const PENDING_TTL = 6 * 60 * 60;
const INIT_DATA_MAX_AGE_SEC = 60 * 60; // Web App 验证数据 1 小时内有效
const HEALTH_CHECK_INTERVAL_SEC = 60 * 60;
const LIST_PAGE_SIZE = 10;
const BUTTON_USER_LIMIT = 30;
const TG_TEXT_LIMIT = 4000;
const DEFAULT_SESSION_IDLE_MINUTES = 30;
const ALBUM_QUIET_MS = 900;
const ALBUM_MAX_WAIT_MS = 3000;
const ALBUM_RECORD_TTL_MS = 24 * 60 * 60 * 1000;
const BACKUP_MAX_BYTES = 1024 * 1024;
const BACKUP_MAX_ENTRIES = 5000;
const BACKUP_LIMIT = 10;
const DEFAULT_AWAY_TEXT = "收到你的消息了，我现在暂时不在，稍后会回复你。";

const USER_GUIDE_TEXT =
  "ฅ˙Ⱉ˙ฅ 使用说明\n" +
  "━━━━━━━━━━━━━━\n" +
  "✨ /start\n开始或重新获取验证链接\n\n" +
  "🕘 /status\n查看当前状态\n\n" +
  "💡 /help\n查看这份说明\n\n" +
  "💬 验证完成后\n直接发消息就会转达给主人";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "POST") {
      const config = getConfig(env);
      if (!config.ok) {
        console.error("Missing env bindings:", config.missing.join(", "));
        return new Response("Config error", { status: 500 });
      }
      if (url.pathname !== "/verify-submit" && !timingSafeEqual(request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "", config.webhookSecret)) {
        return new Response("Forbidden", { status: 403 });
      }
      if (!env.BOT_STATE) return new Response("Missing BOT_STATE binding; see deployment guide", { status: 503 });
      return env.BOT_STATE.get(env.BOT_STATE.idFromName(`bot:${config.adminId}`)).fetch(request);
    }
    return handleRequest(request, env, ctx);
  },
};

async function handleRequest(request, env, ctx) {
  const config = getConfig(env);
  config.waitUntil = ctx?.waitUntil ? (promise) => ctx.waitUntil(promise) : null;
  if (!config.ok) {
    console.error("Missing env bindings:", config.missing.join(", "));
    return new Response("Config error", { status: 500 });
  }

  const url = new URL(request.url);

  // --- Web 路由：Turnstile + Telegram Web App 验证 ---
  if (request.method === "GET" && url.pathname === "/verify") {
    return serveTurnstilePage(config);
  }

  if (request.method === "POST" && url.pathname === "/verify-submit") {
    try {
      return await handleTurnstileSubmit(request, env, config, ctx);
    } catch (error) {
      console.error("Verify submit error:", redactSensitiveInfo(error?.message || error, env));
      return textResponse("验证出错，请关闭页面后重新发送 /start。", 500);
    }
  }

  // --- Telegram Webhook 路由 ---
  if (request.method !== "POST") {
    return new Response("OK");
  }

  // 校验请求确实来自 Telegram（setWebhook 时设置的 secret_token）
  const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
  if (!timingSafeEqual(secretHeader, config.webhookSecret)) {
    return new Response("Forbidden", { status: 403 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("OK");
  }

  try {
    if (body.callback_query) {
      await handleCallback(body.callback_query, env, config);
      return new Response("OK");
    }

    if (body.edited_message) {
      await handleEditedMessage(body.edited_message, body.update_id, env, config);
      return new Response("OK");
    }

    if (!body.message) {
      return new Response("OK");
    }

    const msg = body.message;

    // 只处理私聊，忽略群组 / 频道
    if (msg.chat?.type !== "private") {
      return new Response("OK");
    }

    const chatId = String(msg.chat?.id || "");
    const text = (msg.text || "").trim();
    const now = Date.now();

    if (!chatId) {
      return new Response("OK");
    }

    await retainLatestUiCommand(msg, text, env, config);
    if (chatId === config.adminId) {
      await handleAdminMessage(msg, text, env, config);
      return new Response("OK");
    }

    ctx.waitUntil(checkTurnstileHealth(env, config).catch((e) => console.error("Health check error:", redactSensitiveInfo(e?.message || e, env))));
    await handleUserMessage(msg, text, chatId, now, env, config, request.url);
    return new Response("OK");
  } catch (error) {
    console.error("Unhandled worker error:", redactSensitiveInfo(error?.message || error, env));
    if (config.runtime) await config.runtime.recordFailure("请求处理", error?.message || error);
    ctx.waitUntil(
      safeNotifyAdmin(env, config, `⚠️ Worker 异常\n${redactSensitiveInfo(error?.message || error, env)}`)
    );
    return new Response("Temporary failure", { status: 503 });
  }
}

function getConfig(env) {
  const missing = [];
  if (!env.BOT_TOKEN) missing.push("BOT_TOKEN");
  if (!env.MY_ADMIN_ID) missing.push("MY_ADMIN_ID");
  if (!env.BOT_KV) missing.push("BOT_KV");
  if (!env.WEBHOOK_SECRET) missing.push("WEBHOOK_SECRET");
  if (!env.TURNSTILE_SITE_KEY) missing.push("TURNSTILE_SITE_KEY");
  if (!env.TURNSTILE_SECRET) missing.push("TURNSTILE_SECRET");

  return {
    ok: missing.length === 0,
    missing,
    adminId: String(env.MY_ADMIN_ID || ""),
    botToken: env.BOT_TOKEN || "",
    welcomeImage: env.WELCOME_IMAGE || "",
    apiUrl: `https://api.telegram.org/bot${env.BOT_TOKEN}/`,
    webhookSecret: env.WEBHOOK_SECRET || "",
    turnstileSiteKey: env.TURNSTILE_SITE_KEY || "",
    turnstileSecret: env.TURNSTILE_SECRET || "",
    runtime: env.__botRuntime || null,
  };
}

// ==========================================
// 网页验证（Telegram Web App initData 签名校验 + Turnstile）
// ==========================================

function serveTurnstilePage(config) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>安全验证</title>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
    <style>
        * { box-sizing: border-box; }
        html { background: var(--tg-theme-secondary-bg-color, #f2f2f7); }
        body {
            margin: 0; min-height: 100vh;
            min-height: var(--tg-viewport-stable-height, 100dvh);
            background: var(--tg-theme-secondary-bg-color, #f2f2f7);
            display: flex; flex-direction: column; align-items: center; justify-content: flex-start;
            padding: 48px 12px 24px;
            padding-top: calc(16px + clamp(24px, calc(var(--tg-viewport-stable-height, 100vh) * 0.12), 72px) + env(safe-area-inset-top, 0px));
            padding-bottom: calc(24px + env(safe-area-inset-bottom, 0px));
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        }
        .card { background: var(--tg-theme-bg-color, #fff); padding: 28px 12px; border-radius: 16px; box-shadow: 0 4px 16px rgba(0,0,0,0.04); text-align: center; width: 100%; max-width: 360px; flex-shrink: 0; }
        .cf-turnstile { width: 100%; }
        #close-window { border: 0; border-radius: 10px; padding: 11px 20px; background: var(--tg-theme-button-color, #2481cc); color: var(--tg-theme-button-text-color, #fff); font: inherit; cursor: pointer; }
        @media (max-width: 348px) { body { padding-left: 4px; padding-right: 4px; } .card { padding-left: 4px; padding-right: 4px; } }
        h2 { margin-top: 0; color: var(--tg-theme-text-color, #1c1c1e); font-size: 1.25rem; font-weight: 600;}
        p { color: var(--tg-theme-hint-color, #8e8e93); font-size: 0.9rem; margin-bottom: 1.5rem; line-height: 1.5;}
        #outside { display: none; color: #ff3b30; }
    </style>
</head>
<body>
    <div class="card">
        <h2>人机身份验证</h2>
        <p>为防止自动化脚本滥用，<br>请完成下方验证以接通对话。</p>
        <p id="outside">请在 Telegram 中点击机器人发送的按钮打开此页面。</p>
        <p id="result" role="status" style="display:none"></p>
        <button id="close-window" type="button" style="display:none" onclick="closeApp()">返回聊天</button>
        <form id="challenge-form" action="/verify-submit" method="POST">
            <input type="hidden" name="initData" id="initData" value="">
            <div class="cf-turnstile" data-sitekey="${escapeHtml(config.turnstileSiteKey)}" data-size="flexible" data-callback="onSuccess"></div>
        </form>
    </div>
    <script>
        var tg = window.Telegram && window.Telegram.WebApp;
        if (tg && tg.initData) {
            tg.ready();
            document.getElementById("initData").value = tg.initData;
        } else {
            document.getElementById("outside").style.display = "block";
            document.getElementById("challenge-form").style.display = "none";
        }
        var submitting = false;
        function closeApp() {
            if (tg) {
                try { if (tg.disableClosingConfirmation) tg.disableClosingConfirmation(); } catch (_) {}
                try { tg.close(); } catch (_) {}
            }
        }
        async function onSuccess(token) {
            if (submitting) return;
            submitting = true;
            var result = document.getElementById("result");
            result.style.display = "block";
            result.textContent = "正在验证…";
            var controller = new AbortController();
            var timer = setTimeout(function () { controller.abort(); }, 15000);
            try {
                var body = new URLSearchParams({initData: tg.initData, "cf-turnstile-response": token});
                var response = await fetch("/verify-submit", {method: "POST", headers: {Accept: "application/json"}, body: body, signal: controller.signal});
                if (!response.ok) throw new Error(await response.text());
                var data = await response.json();
                if (!data.ok) throw new Error("验证未完成，请重试。");
                document.querySelector("h2").textContent = "✅ 验证成功";
                document.getElementById("challenge-form").style.display = "none";
                result.textContent = "现在可以发送消息";
                document.getElementById("close-window").style.display = "inline-block";
                closeApp();
            } catch (error) {
                result.textContent = error.name === "AbortError" ? "网络响应超时，请重试；已完成的授权不会撤销。" : error.message || "网络异常，请重试。";
                submitting = false;
                if (window.turnstile) window.turnstile.reset();
            } finally { clearTimeout(timer); }
        }
    </script>
</body>
</html>`;

  return new Response(html, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
}

async function handleTurnstileSubmit(request, env, config, ctx) {
  let formData;
  try {
    formData = await request.formData();
  } catch {
    return textResponse("无效的提交", 400);
  }

  const token = formData.get("cf-turnstile-response");
  const initData = formData.get("initData");

  if (!token || !initData) {
    return textResponse("无效的提交", 400);
  }

  // 1. 校验 Telegram Web App 签名，身份只信任 initData 中的 user.id
  const tgUser = await verifyTelegramInitData(String(initData), config.botToken);
  if (!tgUser) {
    return textResponse("身份校验失败，请关闭页面后重新发送 /start 获取链接。", 403);
  }
  const chatId = String(tgUser.id);

  if (chatId === config.adminId) {
    return verificationSuccessResponse(request);
  }

  // 2. 被封禁用户不能通过验证
  const lockUntil = Number((await env.BOT_KV.get(`lock_${chatId}`)) || 0);
  if (lockUntil && Date.now() < lockUntil) {
    return textResponse("当前无法访问。", 403);
  }

  const alreadyAuthed = (await env.BOT_KV.get(`auth_${chatId}`)) === "true";
  if (alreadyAuthed) { await saveContactProfile(env.BOT_KV, chatId, { firstName: tgUser.first_name || "", username: tgUser.username || "" }); return verificationSuccessResponse(request); }

  // 3. 尚未授权时校验 Turnstile
  const verifyBody = new URLSearchParams({ secret: config.turnstileSecret, response: String(token) });
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) verifyBody.set("remoteip", ip);

  const verifyRes = await fetchWithTimeout("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: verifyBody.toString(),
  });
  const verifyData = await safeJson(verifyRes);

  if (!verifyData.success) {
    return textResponse("验证失败，请关闭页面后重新发送 /start 获取链接。", 403);
  }

  await completeUserVerification(chatId, tgUser, env, config, ctx);
  return verificationSuccessResponse(request);
}

function verificationSuccessResponse(request) {
  if ((request.headers.get("Accept") || "").includes("application/json")) return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  const successHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>验证成功</title><script src="https://telegram.org/js/telegram-web-app.js"></script></head><body><h2>✅ 验证成功</h2><p>现在可以发送消息</p><button onclick="Telegram.WebApp.close()">返回聊天</button><script>if (window.Telegram && window.Telegram.WebApp) Telegram.WebApp.close();</script></body></html>`;
  return new Response(successHtml, { headers: { "Content-Type": "text/html;charset=UTF-8", "Cache-Control": "no-store" } });
}

/**
 * 按 Telegram 官方算法校验 Web App initData：
 * secret_key = HMAC_SHA256(key="WebAppData", data=bot_token)
 * hash       = hex(HMAC_SHA256(key=secret_key, data=data_check_string))
 * 返回 user 对象，失败返回 null。
 */
async function verifyTelegramInitData(initData, botToken, maxAgeSec = INIT_DATA_MAX_AGE_SEC) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return null;
    params.delete("hash");

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");

    const enc = new TextEncoder();
    const secretKey = await hmacSha256(enc.encode("WebAppData"), enc.encode(botToken));
    const signature = await hmacSha256(secretKey, enc.encode(dataCheckString));

    if (!timingSafeEqual(toHex(signature), hash.toLowerCase())) return null;

    const authDate = Number(params.get("auth_date") || 0);
    if (!Number.isFinite(authDate) || !authDate || authDate > Date.now() / 1000 + 30 || Date.now() / 1000 - authDate > maxAgeSec) return null;

    const user = JSON.parse(params.get("user") || "null");
    if (!user || !/^\d+$/.test(String(user.id))) return null;
    return user;
  } catch (error) {
    console.warn("initData verify failed:", redactSensitiveInfo(error?.message || error, { BOT_TOKEN: botToken }));
    return null;
  }
}

async function hmacSha256(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, dataBytes));
}

function toHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  const x = String(a);
  const y = String(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

function textResponse(text, status = 200) {
  return new Response(text, { status, headers: { "Content-Type": "text/plain;charset=UTF-8" } });
}

// ==========================================
// 核心机器人逻辑
// ==========================================

async function markUserAsReplied(userId, env, updatedAt = Date.now()) {
  await env.BOT_KV.put(`replied_${userId}`, "true", { expirationTtl: IMMUNITY_TTL, metadata: { updatedAt } });
}

async function recordAdminCommunication(userId, env, config, delivery = null) {
  const id = String(userId);
  if (id === config.adminId) return;
  const recent = await getRecentUserById(env.BOT_KV, id);
  const updatedAt = Math.max(normalizeTimestamp(recent?.updatedAt), delivery?.createdAt || Date.now());
  let firstName = recent?.firstName || "";
  let username = recent?.username || "";
  if (!firstName && !username) {
    try {
      const profile = await safeJson(await callApi("getChat", { chat_id: id }, { ...config, apiTimeoutMs: 1500 }));
      if (profile.ok) {
        firstName = profile.result?.first_name || "";
        username = profile.result?.username || "";
      }
    } catch (error) {
      console.warn("Contact profile unavailable:", redactSensitiveInfo(error?.message || error, env));
    }
  }
  await markUserAsReplied(id, env, updatedAt);
  await env.BOT_KV.put(`recent_${id}`, JSON.stringify({ id, firstName, username, updatedAt }), { expirationTtl: RECENT_USER_TTL });
  await saveContactProfile(env.BOT_KV, id, { firstName, username });
  await clearAwaitingReply(id, env.BOT_KV, delivery?.pendingIds);
  const active = await getActiveAdminTarget(env.BOT_KV, config.adminId);
  if (active?.userId === id) await setActiveAdminTarget(env.BOT_KV, config.adminId, id, firstName || active.name);
}

async function handleAdminMessage(msg, text, env, config) {
  const chatId = config.adminId;
  // 管理员任何新消息都截断访客连续消息组；只重置分组，不清理上一组身份。
  await interruptVisitorRelayGroup(env, config, msg.message_id);
  const command = text.startsWith("/") ? text.split(/\s+/)[0].split("@")[0].toLowerCase() : "";
  if (command === "/start") {
    await resetAdminActions(env, config);
    await sendLatestStart(chatId, () => sendMediaOrText(chatId, config.welcomeImage, "ฅ˙Ⱉ˙ฅ 欢迎回来~系统运行中\n发送 /admin 呼出控制台", env, config), env, config);
    return;
  }

  if (["/admin", "/help"].includes(command) || text === "指令") {
    await resetAdminActions(env, config);
    try {
      await sendAdminMenu(chatId, env, config);
    } catch (error) {
      const reason = redactSensitiveInfo(error?.message || error, env);
      console.error("Error sending admin menu:", reason);
      await sendMessage(
        chatId,
        `⚠️ 控制台加载失败\n${reason}\n请将这条错误提示反馈给维护者。`,
        env,
        config
      );
    }
    return;
  }

  if (["/note", "/search", "/session", "/diagnose", "/list", "/inbox", "/done", "/quick", "/away", "/backup", "/restore", "/send"].includes(command)) await resetAdminActions(env, config);
  if (await handleAdminTools(msg, text, env, config)) return;

  // 带 ID 的管理指令：解封 123 / 拉黑 123 / 撤销 123
  const idCmdMatch = text.match(/^(解封|拉黑|撤销授权|撤销)\s+(\d+)$/);
  if (idCmdMatch) {
    const [, action, targetId] = idCmdMatch;
    if (action === "解封") await unbanUser(targetId, env, config);
    if (action === "拉黑") await banUser(targetId, env, config);
    if (action === "撤销授权" || action === "撤销") await revokeAuth(targetId, env, config);
    return;
  }

  // 定向推送：/send 123 内容（需要明确前缀，避免以数字开头的普通回复被误发给别人）
  const idPushMatch = text.match(/^\/send(?:@[A-Za-z0-9_]+)?\s+([1-9]\d{0,19})\s+([\s\S]+)$/i);
  if (idPushMatch) {
    const [, targetId, content] = idPushMatch;
    const res = await isOutboundBlocked(targetId, env, config)
      ? blockedDelivery() : await performSingleDelivery("sendMessage", { chat_id: targetId, text: escapeMarkdownV2(content), parse_mode: "MarkdownV2" }, msg, "push", env, config);
    if (res.ok) {
      await recordAdminCommunication(targetId, env, config, await singleDeliveryRecord(msg, config));
      await recordMessageOrigin(msg, targetId, res.result?.message_id, "push", env);
      await sendAutoDeleteHtmlMessage(chatId, `✅ 推送成功\n目标：<code>${escapeHtml(targetId)}</code>`, env, config);
    } else {
      const targetLabel = await formatTargetLabel(env.BOT_KV, targetId);
      await sendMessage(chatId, `${res.uncertain ? "⚠️ 发送结果未确认" : "❌ 发送失败"}\n对象：${targetLabel}\n${formatDeliveryFailure(res.description)}`, env, config);
    }
    return;
  }

  // 未识别的指令不转发给访客
  if (text.startsWith("/")) {
    await sendMessage(chatId, "💡 未知指令\n发送 /admin 查看控制台", env, config);
    return;
  }

  if (msg.media_group_id && config.runtime) {
    await config.runtime.enqueueAdminAlbum(msg, env, config);
    return;
  }

  // 回复某条转发消息 / 访客通知
  if (msg.reply_to_message) {
    const replyToId = String(msg.reply_to_message.message_id);
    const savedDelivery = await singleDeliveryRecord(msg, config);
    const targetUserId = savedDelivery?.targetId || await env.BOT_KV.get(`msg_${replyToId}`);
    if (!targetUserId) {
      await sendMessage(chatId, "๑ᵒᯅᵒ๑ 会话失效了\n这条映射可能已经过期", env, config);
      return;
    }

    if (text === "解封") { await unbanUser(targetUserId, env, config); return; }
    if (text === "拉黑") { await banUser(targetUserId, env, config); return; }
    if (text === "撤销授权" || text === "撤销") { await revokeAuth(targetUserId, env, config); return; }
    if (await isOutboundBlocked(targetUserId, env, config)) { await sendMessage(chatId, "该联系人正在封禁中，请先解封", env, config); return; }
    const recentUser = await getRecentUserById(env.BOT_KV, targetUserId);
    if (!savedDelivery) await setActiveAdminTarget(env.BOT_KV, config.adminId, targetUserId, recentUser?.firstName || "这个访客");

    const copied = await copyMessage(targetUserId, config.adminId, msg.message_id, env, config, msg);
    if (copied.ok) {
      await recordMessageOrigin(msg, targetUserId, copied.result?.message_id, "admin", env, { transport: hasForwardOrigin(msg) ? "forward" : "copy", replyMarkup: hasForwardOrigin(msg) ? null : preservedRelayButtons(msg) });
      await recordAdminCommunication(targetUserId, env, config, await singleDeliveryRecord(msg, config));
      await sendAutoDeleteHtmlMessage(chatId, `✅ 已回复并切换会话\n对象：${formatContactNameHtml(recentUser?.firstName || "这个访客", recentUser?.username, targetUserId)}\nID：<code>${escapeHtml(targetUserId)}</code>`, env, config);
    }
    return;
  }

  // 当前会话
  const savedDelivery = await singleDeliveryRecord(msg, config);
  const activeTarget = savedDelivery?.kind === "admin" ? { userId: savedDelivery.targetId, name: (await getRecentUserById(env.BOT_KV, savedDelivery.targetId))?.firstName } : await getActiveAdminTarget(env.BOT_KV, config.adminId);
  if (activeTarget) {
    const copied = await copyMessage(activeTarget.userId, config.adminId, msg.message_id, env, config, msg);
    if (copied.ok) {
      await recordMessageOrigin(msg, activeTarget.userId, copied.result?.message_id, "admin", env, { transport: hasForwardOrigin(msg) ? "forward" : "copy", replyMarkup: hasForwardOrigin(msg) ? null : preservedRelayButtons(msg) });
      await recordAdminCommunication(activeTarget.userId, env, config, await singleDeliveryRecord(msg, config));
      const recentUser = await getRecentUserById(env.BOT_KV, activeTarget.userId);
      await sendAutoDeleteHtmlMessage(chatId, `${formatContactNameHtml(activeTarget.name || "这个访客", recentUser?.username, activeTarget.userId)} ID：<code>${escapeHtml(activeTarget.userId)}</code>发送成功✅`, env, config);
    }
    return;
  }

  await sendMessage(chatId, "💡 先回复访客消息\n或在最近访客里点昵称切换会话", env, config);
}

async function handleUserMessage(msg, text, chatId, now, env, config, requestUrl) {
  const kv = env.BOT_KV;
  const lockUntil = Number((await kv.get(`lock_${chatId}`)) || 0);

  if (lockUntil && now < lockUntil) {
    await sendMessage(chatId, "🚫 当前无法访问\n稍后再试吧", env, config, {}, { notifyOnFail: false });
    return;
  }

  await touchRecentUser(msg, chatId, now, env);

  const isAuthed = (await kv.get(`auth_${chatId}`)) === "true";
  // 兼容 /start payload 和 /help@BotName 这类写法
  const command = text.startsWith("/") ? text.split(/\s+/)[0].split("@")[0] : "";

  const handled = await handleUserCommand(command, chatId, now, isAuthed, lockUntil, env, config);
  if (handled) return;

  if (command === "/start") {
    await handleStart(msg, chatId, isAuthed, env, config, requestUrl);
    return;
  }

  if (isAuthed) {
    if (msg.media_group_id && config.runtime) {
      await config.runtime.enqueueUserAlbum(msg, chatId, now, env, config);
      return;
    }
    const rateLimit = await singleDeliveryRecord(msg, config) ? { blocked: false } : await checkAndConsumeRateLimit(chatId, now, env);
    if (rateLimit.blocked) {
      await sendMessage(chatId, `⏳ 发得有点快啦\n${rateLimit.retryAfter} 秒后再试试吧~`, env, config);
      return;
    }
    await relayAuthedUserMessage(msg, chatId, env, config);
    return;
  }

  await sendMessage(chatId, "૮ ・ﻌ・ぁ 请先发送 /start 获取链接完成验证", env, config);
}

async function handleUserCommand(command, chatId, now, isAuthed, lockUntil, env, config) {
  if (!command) return false;

  if (command === "/admin") {
    const adminNickname = await getAdminDisplayName(env, config);
    const tip = isAuthed
      ? `ʕ⸝⸝⸝˙Ⱉ˙ʔ ♡ 这里是 ${adminNickname} 的传话筒\n请直接输入消息吧~`
      : `૮ •𖥦• აᐝ 这里是 ${adminNickname} 的传话筒\n先发 /start 完成验证哦~`;
    await sendLatestUi(chatId, "help", () => sendMessage(chatId, tip, env, config), env, config);
    return true;
  }

  if (command === "/help") {
    const extra = isAuthed ? "\n\n✅ 当前状态\n已通过验证\n可以直接发送消息啦~" : "\n\n⌛ 当前状态\n还没有完成验证\n请先发送 /start";
    await sendLatestUi(chatId, "help", () => sendMessage(chatId, USER_GUIDE_TEXT + extra, env, config), env, config);
    return true;
  }

  if (command === "/status") {
    await sendMessage(chatId, buildUserStatusText(now, isAuthed, lockUntil), env, config);
    return true;
  }

  return false;
}

async function handleStart(msg, chatId, isAuthed, env, config, requestUrl) {
  if (isAuthed) {
    await sendLatestStart(chatId, () => sendMediaOrText(chatId, config.welcomeImage, "✨ 已完成验证₍^˶ ╸𖥦  ╸˵^₎⟆\n直接输入想要发送的消息吧~", env, config), env, config);
    return;
  }

  const kv = env.BOT_KV;
  // 验证链接中不再携带用户 ID，身份由 Telegram 签名的 initData 确定
  const verifyUrl = `${new URL(requestUrl).origin}/verify`;

  // 新提示成功后才替换旧提示，发送失败时保留原验证入口。
  await sendLatestStart(chatId, () => sendMessage(chatId, "🛡️ 为了防止滥用，请点击下方按钮完成安全验证：", env, config, {
    reply_markup: { inline_keyboard: [[{ text: "👉 点击进入验证页面", web_app: { url: verifyUrl } }]] },
  }), env, config, true);

  // 记录待验证状态（用于健康监控统计），不立即通知管理员
  const pendingData = {
    id: chatId,
    firstName: msg.from?.first_name || "未知用户",
    username: msg.from?.username || "",
    timestamp: Date.now(),
  };
  await kv.put(`pending_${chatId}`, JSON.stringify(pendingData), { expirationTtl: PENDING_TTL });
}

function buildUserStatusText(now, isAuthed, lockUntil) {
  if (lockUntil && now < lockUntil) {
    const remainMinutes = Math.max(1, Math.ceil((lockUntil - now) / 60000));
    return `🚫 当前状态：已锁定\n预计 ${remainMinutes} 分钟后重试`;
  }
  if (isAuthed) return "✅ 当前状态：已通过验证\n现在可以直接发送消息";
  return "💡 当前状态：未验证\n发送 /start 获取验证链接";
}

async function relayAuthedUserMessage(msg, chatId, env, config) {
  const kv = env.BOT_KV;
  const bodyType = relayBodyType(msg);
  const name = msg.from?.first_name || msg.from?.username || (await getRecentUserById(kv, chatId))?.firstName;
  const baseReplyMarkup = preservedRelayButtons(msg);
  const replyMarkup = visitorRelayButtons(chatId, name, baseReplyMarkup);
  const useCopy = canCopyRelayMessage(msg) && !hasForwardOrigin(msg);
  const fData = useCopy
    ? await performSingleDelivery("copyMessage", { chat_id: config.adminId, from_chat_id: chatId, message_id: msg.message_id, reply_markup: replyMarkup }, msg, "visitor", env, config)
    : await forwardMessage(config.adminId, chatId, msg.message_id, env, config, msg);

  if (!fData.ok || !fData.result?.message_id) {
    await sendMessage(chatId, fData.uncertain ? "⚠️ 消息发送结果未确认，请检查聊天记录后决定是否重新发送" : "😿 消息暂时没能送达\n请稍后再试", env, config, {}, { notifyOnFail: false });
    return;
  }

  await kv.put(`msg_${fData.result.message_id}`, chatId, { expirationTtl: MSG_MAP_TTL });
  const nativeButtons = useCopy ? null : nativeForwardButtons(msg, fData.result);
  const originalButtons = useCopy ? baseReplyMarkup : nativeButtons || preservedRelayButtons({ ...msg, reply_markup: fData.result.reply_markup || msg.reply_markup });
  const attached = useCopy
    ? await retainVisitorRelayButton(chatId, msg.message_id, fData.result.message_id, name, originalButtons, env, config, true)
    : nativeButtons !== null && await retainVisitorRelayButton(chatId, msg.message_id, fData.result.message_id, name, nativeButtons, env, config);
  if (!attached) await sendRelayAttribution(chatId, msg.message_id, fData.result.message_id, name, env, config);
  await recordMessageOrigin(msg, config.adminId, fData.result.message_id, "visitor", env, { bodyType, transport: useCopy ? "copy" : "forward",
    replyMarkup: attached ? visitorRelayButtons(chatId, name, originalButtons) : null, baseReplyMarkup: originalButtons, relayContact: attached });
  await recordIncomingMessage(chatId, msg.message_id, kv);
  await maybeSendAwayNotice(chatId, env, config);

  await sendDeliveryReceipt(chatId, env, config);
}

// 欢迎图、控制台与用户界面指令分别记录 ID；发送新界面前先清理旧消息。
async function clearOldUiMessages(chatId, kind, keepId, env, config) {
  const key = `ui_${kind}_${chatId}`, kv = env.BOT_KV;
  const previous = parseObject(await kv.get(key));
  const legacyId = kind === "start" ? Number(await kv.get(`verify_msg_${chatId}`)) : 0;
  const oldIds = [...new Set([previous?.messageId, legacyId])].filter((id) => Number.isSafeInteger(id) && id > 0 && id !== keepId);
  const removedIds = await Promise.all(oldIds.map(async (id) => {
    try {
      // 清理尽快确认；接口异常或超时仍继续发新提示，不让清理长期拖住指令。
      const data = await safeJson(await callApi("deleteMessage", { chat_id: chatId, message_id: id }, { ...config, apiTimeoutMs: 1500 }));
      const removed = data.ok || (data.error_code === 400 && /message to delete not found/i.test(data.description || ""));
      if (removed) {
        if (kind === "menu") await invalidateQuickPanel(id, env, config);
        if ((parseObject(await kv.get(key)))?.messageId === id) await kv.delete(key);
        if (kind === "start" && Number(await kv.get(`verify_msg_${chatId}`)) === id) await kv.delete(`verify_msg_${chatId}`);
        return id;
      } else console.warn("旧界面删除未完成:", redactSensitiveInfo(data.description, env));
    } catch (error) { console.warn("旧界面删除失败:", redactSensitiveInfo(error?.message || error, env)); }
  }));
  if (String(chatId) === config.adminId) await removeVisitorRelaySeparators(removedIds.filter(Number.isSafeInteger), env, config);
}

async function rememberUiMessage(chatId, kind, result, env, config, verification = false) {
  const messageId = result?.result?.message_id;
  if (!result?.ok || !Number.isSafeInteger(messageId) || messageId <= 0) return result;
  await env.BOT_KV.put(`ui_${kind}_${chatId}`, JSON.stringify({ messageId, updatedAt: Date.now() }), { expirationTtl: RECENT_USER_TTL });
  if (kind === "start") {
    if (verification) await env.BOT_KV.put(`verify_msg_${chatId}`, String(messageId), { expirationTtl: PENDING_TTL });
    else await env.BOT_KV.delete(`verify_msg_${chatId}`);
  }
  return result;
}

async function sendLatestUi(chatId, kind, send, env, config, verification = false, keepId = null) {
  const task = async () => {
    await clearOldUiMessages(chatId, kind, keepId, env, config);
    return rememberUiMessage(chatId, kind, await send(), env, config, verification);
  };
  // 欢迎通知仍在后台执行，同一槽位按顺序替换，普通转发不进入这个界面队列。
  return config.runtime ? config.runtime.runUiExclusive(`ui_${kind}_${chatId}`, task) : task();
}

async function retainLatestUiCommand(msg, text, env, config) {
  const command = text.startsWith("/") ? text.split(/\s+/)[0].split("@")[0] : "";
  const chatId = String(msg.chat?.id || "");
  if (!["/start", "/admin", "/help"].includes(command) && !(chatId === config.adminId && text === "指令")) return;
  if (msg.chat?.type !== "private" || !chatId || !Number.isSafeInteger(msg.message_id) || msg.message_id <= 0) return;
  // 在处理指令前删除上一条用户指令，保留当前刚收到的指令。
  await sendLatestUi(chatId, "command", async () => ({ ok: true, result: { message_id: msg.message_id } }), env, config, false, msg.message_id);
}

async function sendLatestStart(chatId, send, env, config, verification = false) {
  return sendLatestUi(chatId, "start", send, env, config, verification);
}

async function sendMediaOrText(chatId, photoUrl, caption, env, config) {
  if (photoUrl && /^https?:\/\//i.test(photoUrl)) {
    const res = await callApi("sendPhoto", { chat_id: chatId, photo: photoUrl, caption: escapeMarkdownV2(caption), parse_mode: "MarkdownV2" }, config);
    const data = await safeJson(res);
    if (data.ok) {
      if (String(chatId) === config.adminId) await interruptVisitorRelayGroup(env, config, data.result?.message_id);
      return data;
    }
  }
  return sendMessage(chatId, caption, env, config);
}

async function banUser(targetUserId, env, config) {
  const kv = env.BOT_KV;
  const [recent, noteRaw] = await Promise.all([getRecentUserById(kv, targetUserId), kv.get(`note_${targetUserId}`)]);
  const note = parseContactNote(noteRaw), active = await getActiveAdminTarget(kv, config.adminId);
  // 将姓名随封禁记录保存，避免清除最近访客后只剩数字 ID；备份同步保留元数据。
  let profile = blacklistProfile({ firstName: recent?.firstName || note?.firstName || (active?.userId === String(targetUserId) ? active.name : ""), username: recent ? recent.username || "" : note?.username || "" });
  if (!profile.firstName && !profile.username) {
    const old = await kv.list({ prefix: `lock_${targetUserId}`, limit: 1 });
    profile = blacklistProfile(old.keys.find((key) => key.name === `lock_${targetUserId}`)?.metadata);
  }
  await kv.put(`lock_${targetUserId}`, String(Date.now() + BAN_TTL * 1000), { expirationTtl: BAN_TTL, metadata: profile });
  await kv.delete(`auth_${targetUserId}`);
  await kv.delete(`recent_${targetUserId}`);
  await kv.delete(`replied_${targetUserId}`);
  await kv.delete(`inbox_${targetUserId}`);

  if (active?.userId === String(targetUserId)) await clearActiveAdminTarget(kv, config.adminId);

  await sendMessage(targetUserId, "🚫 访问锁定\n你已被管理员封禁", env, config, {}, { notifyOnFail: false });
  await sendMessage(config.adminId, `🚫 拉黑成功\n用户 ${targetUserId} 已加入黑名单，30天后将自动清除`, env, config);
}

async function unbanUser(targetUserId, env, config) {
  const kv = env.BOT_KV;
  await kv.put(`auth_${targetUserId}`, "true");
  await kv.delete(`lock_${targetUserId}`);
  await markUserAsReplied(targetUserId, env); // 解封视为管理员主动互动，避免被清理
  await sendMessage(targetUserId, "✨ 权限已恢复\n欢迎回来 ʕ⸝⸝⸝˙Ⱉ˙ʔ ♡", env, config);
  await sendMessage(config.adminId, `✅ 解封成功\n用户 ${targetUserId} 已恢复访问`, env, config);
}

async function revokeAuth(targetUserId, env, config) {
  const kv = env.BOT_KV;
  await kv.delete(`auth_${targetUserId}`);
  await sendMessage(targetUserId, "⚠️ 授权已撤销\n请重新发送 /start", env, config);
  await sendMessage(config.adminId, `✅ 已撤销用户 ${targetUserId} 的授权`, env, config);
}

async function completeUserVerification(chatId, tgUser, env, config, ctx) {
  const kv = env.BOT_KV;
  await kv.put(`auth_${chatId}`, "true");

  await kv.delete(`pending_${chatId}`);

  // 用 Telegram 签名数据中的昵称刷新访客记录
  await env.BOT_KV.put(
    `recent_${chatId}`,
    JSON.stringify({ id: chatId, firstName: tgUser.first_name || "", username: tgUser.username || "", updatedAt: Date.now() }),
    { expirationTtl: RECENT_USER_TTL }
  );
  await saveContactProfile(kv, chatId, { firstName: tgUser.first_name || "", username: tgUser.username || "" });

  await kv.put("stats_last_verified_time", String(Date.now()));
  const notifications = async () => {
    await Promise.allSettled([
      sendLatestStart(chatId, () => sendMediaOrText(chatId, config.welcomeImage, "✨ 验证成功ദ്ദി˶˃ ᵕ ˂ )✧\n现在可以直接发消息啦~", env, config), env, config),
      sendVerificationNotice(chatId, tgUser, env, config),
    ]).then((results) => {
      for (const result of results) if (result.status === "rejected") console.warn("Verification notification failed:", redactSensitiveInfo(result.reason?.message || result.reason, env));
    });
  };
  if (ctx?.waitUntil) ctx.waitUntil(notifications());
  else await notifications();
}

async function sendVerificationNotice(chatId, tgUser, env, config) {
  const kv = env.BOT_KV;
  const firstName = tgUser.first_name || "未知用户";
  const noticeHtml = buildVisitorNoticeHtml(chatId, firstName, tgUser.username, "🎉 状态：已通过网页验证");

  const notice = await sendHtmlMessage(config.adminId, noticeHtml, config, {
    reply_markup: { inline_keyboard: buildNoticeButtons(chatId, firstName, tgUser.username) },
  });

  if (notice.ok && notice.result?.message_id) {
    await kv.put(`msg_${notice.result.message_id}`, chatId, { expirationTtl: MSG_MAP_TTL });
  }

}

function getPublicProfileUrl(username) {
  const value = String(username || "").replace(/^@/, "");
  return /^[A-Za-z0-9_]{1,64}$/.test(value) ? `https://t.me/${value}` : null;
}

function formatContactNameHtml(name, username, userId = "") {
  const label = escapeHtml(name || "未知用户");
  const id = String(userId || "");
  const url = getPublicProfileUrl(username) || (/^\d{1,20}$/.test(id) ? `tg://user?id=${id}` : null);
  return url ? `<a href="${url}">${label}</a>` : label;
}

function buildNoticeButtons(chatId, firstName, username) {
  // nfocus：仅切换会话，不改动这条通知。无公开用户名时不生成主页按钮。
  const row = [{ text: `💬 切换到 ${truncateText(firstName, 10)}`, callback_data: `nfocus:${chatId}` }];
  const profileUrl = getPublicProfileUrl(username);
  if (profileUrl) row.push({ text: "👤 查看主页", url: profileUrl });
  return [row];
}

function buildVisitorNoticeHtml(chatId, firstName, username, statusText = "") {
  const usernameText = username ? `@${username}` : "无用户名";
  const statusLine = statusText ? `\n${escapeHtml(statusText)}` : "";
  return `•͈⚇•͈ 新访客接入\n✨ 用户：${formatContactNameHtml(firstName, username, chatId)}\n👤 用户名：${escapeHtml(usernameText)}\n🆔 ID：<code>${escapeHtml(chatId)}</code>\n💌 回复这条消息即可回传${statusLine}`;
}

// ==========================================
// Telegram API 封装
// ==========================================

async function sendMessage(to, text, env, config, extra = {}, { notifyOnFail = true } = {}) {
  const res = await callApi("sendMessage", { chat_id: to, text: escapeMarkdownV2(text), parse_mode: "MarkdownV2", ...extra }, config);
  const data = await safeJson(res);
  if (data.ok && String(to) === config.adminId) await interruptVisitorRelayGroup(env, config, data.result?.message_id);
  if (!data.ok && notifyOnFail && String(to) !== config.adminId) {
    const targetLabel = await formatTargetLabel(env.BOT_KV, to);
    await safeNotifyAdmin(env, config, `❌ 发送失败\n对象：${targetLabel}\n${formatDeliveryFailure(data.description)}`);
  }
  return data;
}

async function sendHtmlMessage(to, html, config, extra = {}, { preserveRelayGroup = false } = {}) {
  const res = await callApi("sendMessage", { chat_id: to, text: clampHtml(html), parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...extra }, config);
  const data = await safeJson(res);
  if (data.ok && !preserveRelayGroup && String(to) === config.adminId && config.runtime) {
    await interruptVisitorRelayGroup({ BOT_KV: config.runtime.store }, config, data.result?.message_id);
  }
  return data;
}

async function sendAutoDeleteHtmlMessage(to, html, env, config, extra = {}) {
  return runOptionalTask(config, env, "管理员回执", async () => {
    const data = await sendHtmlMessage(to, html, config, extra, { preserveRelayGroup: true });
    if (data.ok && data.result?.message_id) {
      await sleep(RECEIPT_DELETE_DELAY_MS);
      await deleteMessage(to, data.result.message_id, config);
    }
    return data;
  });
}

function runOptionalTask(config, env, label, task) {
  const promise = Promise.resolve().then(task).catch(async (error) => {
    console.warn(label, redactSensitiveInfo(error?.message || error, env));
    if (config.runtime) await config.runtime.recordFailure(label, error?.message || error);
    return { ok: false };
  });
  if (config.waitUntil) { config.waitUntil(promise); return Promise.resolve({ ok: true, queued: true }); }
  return promise;
}

async function sendDeliveryReceipt(chatId, env, config, text = "✌︎˶╹ꇴ╹˶✌︎ 消息送出啦~") {
  return runOptionalTask(config, env, "访客回执", async () => {
    const receipt = await sendMessage(chatId, text, env, config, {}, { notifyOnFail: false });
    if (receipt.ok && receipt.result?.message_id) {
      await sleep(RECEIPT_DELETE_DELAY_MS);
      await deleteMessage(chatId, receipt.result.message_id, config);
    }
  });
}

async function editHtmlMessage(chatId, messageId, html, config, extra = {}) {
  const res = await callApi("editMessageText", { chat_id: chatId, message_id: messageId, text: clampHtml(html), parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...extra }, config);
  let data = await safeJson(res);
  if (data.ok) return data;
  if (String(data.description || "").includes("message is not modified")) {
    return { ok: true, result: { message_id: messageId } };
  }
  // 旧菜单已删除或不能编辑时，发送新菜单；其他错误直接报告。
  if (data.error_code === 400 && /message (?:to edit not found|can't be edited|cannot be edited)/i.test(data.description || "")) {
    const env = config.runtime && String(chatId) === config.adminId ? { ...config.runtime.env, BOT_KV: config.runtime.store } : null;
    const tracked = env && (parseObject(await env.BOT_KV.get(`ui_menu_${chatId}`)))?.messageId === Number(messageId);
    if (tracked) await clearOldUiMessages(chatId, "menu", null, env, config);
    data = await sendHtmlMessage(chatId, html, config, extra);
    if (data.ok) {
      if (tracked) await rememberUiMessage(chatId, "menu", data, env, config);
      return data;
    }
  }
  const reason = redactSensitiveInfo(data.description || "接口未返回有效响应", {
    BOT_TOKEN: config.botToken, WEBHOOK_SECRET: config.webhookSecret, TURNSTILE_SECRET: config.turnstileSecret,
  });
  throw new Error(`Telegram ${data.error_code || ""}: ${reason}`);
}

async function editMarkdownMessage(chatId, messageId, text, config, extra = {}) {
  const res = await callApi("editMessageText", { chat_id: chatId, message_id: messageId, text: escapeMarkdownV2(text), parse_mode: "MarkdownV2", ...extra }, config);
  return safeJson(res);
}

async function forwardMessage(to, from, id, env, config, source = null) {
  const payload = { chat_id: to, from_chat_id: from, message_id: id };
  const data = source ? await performSingleDelivery("forwardMessage", payload, source, "visitor", env, config) : await safeJson(await callApi("forwardMessage", payload, config));
  if (!data.ok) await safeNotifyAdmin(env, config, `❌ 消息转发失败\n来源：${from}\n消息 ID：${id}\n${formatDeliveryFailure(data.description)}`);
  return data;
}

// 删除失败（如消息超过 48 小时）很常见，只记录日志，不打扰管理员
async function deleteMessage(chatId, messageId, config) {
  const res = await callApi("deleteMessage", { chat_id: chatId, message_id: messageId }, config);
  const data = await safeJson(res);
  if (String(chatId) === config.adminId && config.runtime && (data.ok || (data.error_code === 400 && /message to delete not found/i.test(data.description || "")))) {
    await removeVisitorRelaySeparators([messageId], { BOT_KV: config.runtime.store }, config);
  }
  if (!data.ok) console.warn(`deleteMessage failed (${chatId}/${messageId}):`, data.description);
  return data;
}

async function copyMessage(to, from, id, env, config, source = null) {
  if (await isOutboundBlocked(to, env, config)) {
    await safeNotifyAdmin(env, config, "该联系人正在封禁中，请先解封"); return blockedDelivery();
  }
  const forwarded = source && hasForwardOrigin(source), markup = source ? preservedRelayButtons(source) : null;
  const payload = { chat_id: to, from_chat_id: from, message_id: id, ...(!forwarded && markup?.inline_keyboard.length ? { reply_markup: markup } : {}) };
  const data = source ? await performSingleDelivery(forwarded ? "forwardMessage" : "copyMessage", payload, source, "admin", env, config)
    : await safeJson(await callApi(forwarded ? "forwardMessage" : "copyMessage", payload, config));
  if (!data.ok) {
    const targetLabel = await formatTargetLabel(env.BOT_KV, to);
    await safeNotifyAdmin(env, config, `❌ 发送失败\n对象：${targetLabel}\n${formatDeliveryFailure(data.description)}`);
  }
  return data;
}

async function isOutboundBlocked(targetId, env, config) {
  return String(targetId) !== config.adminId && Number(await env.BOT_KV.get(`lock_${targetId}`)) > Date.now();
}
function blockedDelivery() { return { ok: false, error_code: 403, description: "该联系人正在封禁中，请先解封" }; }
async function singleDeliveryRecord(msg, config) {
  return config.runtime && Number.isSafeInteger(msg?.message_id) ? await config.runtime.ctx.storage.get(`s:${msg.chat.id}:${msg.message_id}`) : null;
}
async function performSingleDelivery(method, payload, msg, kind, env, config) {
  if (!config.runtime) return safeJson(await callApi(method, payload, config));
  const storage = config.runtime.ctx.storage, key = `s:${msg.chat.id}:${msg.message_id}`;
  const previous = await storage.get(key);
  if (previous) {
    if (previous.state === "sent" || previous.state === "failed") return previous.result;
    return { ok: false, uncertain: true, description: "上次发送结果未确认；请检查聊天记录后决定是否重新发送" };
  }
  const job = { kind, targetId: String(payload.chat_id), createdAt: Date.now(), updatedAt: Date.now(), state: "sending" };
  if (kind !== "visitor") job.pendingIds = parseInbox(await env.BOT_KV.get(`inbox_${job.targetId}`)).pendingIds;
  // 先持久化开始状态；重建后遇到未确认操作不自动创建第二条消息。
  await storage.put(key, job); await config.runtime.store.scheduleAlarm();
  let result;
  try { result = await safeJson(await callApi(method, payload, config)); }
  catch (error) { result = { ok: false, uncertain: true, description: redactSensitiveInfo(error?.message || error, env) }; }
  if (result.ok && Number.isSafeInteger(result.result?.message_id) && result.result.message_id > 0) {
    result = { ok: true, result: { message_id: result.result.message_id, ...(result.result.reply_markup ? { reply_markup: result.result.reply_markup } : {}) } };
    job.state = "sent";
  } else if (result.uncertain || !Number.isInteger(result.error_code)) {
    result = { ok: false, uncertain: true, description: "发送结果未确认；请检查聊天记录后决定是否重新发送" }; job.state = "uncertain";
  } else job.state = "failed";
  await storage.put(key, { ...job, result, updatedAt: Date.now() });
  return result;
}

async function callApi(method, data, config) {
  const recordMetric = async (elapsed, ok, reason) => {
    if (!config.runtime) return;
    try { await config.runtime.recordApi(method, elapsed, ok, reason); }
    catch (error) { console.warn("接口诊断记录失败:", redactSensitiveInfo(error?.message || error, { BOT_TOKEN: config.botToken, WEBHOOK_SECRET: config.webhookSecret, TURNSTILE_SECRET: config.turnstileSecret })); }
  };
  const request = async (payload) => {
    const started = Date.now();
    try {
      const response = await fetchWithTimeout(config.apiUrl + method, {
        method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(payload, (_, value) => typeof value === "string" ? toSafeUnicode(value) : value),
      }, config.apiTimeoutMs ?? 12000);
      if (config.runtime) {
        const result = await safeJson(response.clone());
        await recordMetric(Date.now() - started, result.ok === true, result.description);
      }
      return response;
    } catch (error) {
      await recordMetric(Date.now() - started, false, error?.message || error);
      throw error;
    }
  };
  const response = await request(data);
  const rows = data.reply_markup?.inline_keyboard;
  const isPrivateProfileButton = (button) => /^tg:\/\/user\?/i.test(button.url || "");
  const hasPrivateButtons = Array.isArray(rows) && rows.some((row) => row.some(isPrivateProfileButton));
  const stripPrivateMentions = (text) => typeof text === "string"
    ? text.replace(/<a href="tg:\/\/user\?id=\d+">([^<]*)<\/a>/g, "$1") : text;
  const hasPrivateMentions = data.parse_mode === "HTML" && (stripPrivateMentions(data.text) !== data.text || stripPrivateMentions(data.caption) !== data.caption);
  const isPrivateMentionEntity = (entity) => entity?.type === "text_mention" || (entity?.type === "text_link" && /^tg:\/\/user\?id=\d+$/.test(entity.url || ""));
  const hasPrivateEntities = [data.entities, data.caption_entities].some((entities) => Array.isArray(entities) && entities.some(isPrivateMentionEntity));
  const richHtml = data.rich_message?.html;
  const hasPrivateRichMentions = typeof richHtml === "string" && stripPrivateMentions(richHtml) !== richHtml;
  const hasPrivateMediaEntities = Array.isArray(data.media?.caption_entities) && data.media.caption_entities.some(isPrivateMentionEntity);
  if (!hasPrivateButtons && !hasPrivateMentions && !hasPrivateEntities && !hasPrivateRichMentions && !hasPrivateMediaEntities) return response;
  const result = await safeJson(response.clone());
  if (result.error_code !== 400 || !/\b(?:BUTTON_)?USER_PRIVACY_RESTRICTED\b/.test(String(result.description || ""))) return response;
  // 只有接口明确拒绝隐私链接时才退回普通昵称，保留菜单和切换按钮。
  const fallback = { ...data };
  if (hasPrivateMediaEntities) fallback.media = { ...data.media, caption_entities: data.media.caption_entities.filter((entity) => !isPrivateMentionEntity(entity)) };
  if (hasPrivateRichMentions) fallback.rich_message = { ...data.rich_message, html: stripPrivateMentions(richHtml) };
  if (hasPrivateMentions) {
    if (typeof data.text === "string") fallback.text = stripPrivateMentions(data.text);
    if (typeof data.caption === "string") fallback.caption = stripPrivateMentions(data.caption);
  }
  if (hasPrivateEntities) {
    for (const field of ["entities", "caption_entities"]) if (Array.isArray(data[field])) fallback[field] = data[field].filter((entity) => !isPrivateMentionEntity(entity));
  }
  if (hasPrivateButtons) {
    fallback.reply_markup = { ...data.reply_markup, inline_keyboard: rows.map((row) => row.filter((button) => !isPrivateProfileButton(button))).filter((row) => row.length) };
  }
  return request(fallback);
}

async function answerCallback(query, config, text, showAlert = false) {
  const payload = { callback_query_id: query.id };
  if (text) {
    payload.text = text;
    payload.show_alert = showAlert;
  }
  try { await callApi("answerCallbackQuery", payload, { ...config, apiTimeoutMs: 1500 }); }
  catch (error) { console.warn("按钮应答未确认:", redactSensitiveInfo(error?.message || error, { BOT_TOKEN: config.botToken, WEBHOOK_SECRET: config.webhookSecret, TURNSTILE_SECRET: config.turnstileSecret })); }
}

// ==========================================
// 管理员控制台回调
// ==========================================

async function handleCallback(query, env, config) {
  if (query.data === "relay_source_button") {
    await answerCallback(query, config, "此按钮属于原机器人，请打开原消息使用", true);
    return;
  }
  const fromId = String(query.from?.id || "");
  if (fromId !== config.adminId) {
    await answerCallback(query, config);
    return;
  }

  const adminId = config.adminId;
  if (query.message?.chat && (String(query.message.chat.id) !== adminId || query.message.chat.type !== "private")) {
    await answerCallback(query, config); return;
  }
  const data = String(query.data || "");
  if (data === "list_page_info") {
    await answerCallback(query, config);
    return;
  }

  const messageId = query.message?.message_id;
  const kv = env.BOT_KV;
  const clearNonce = await kv.get(`admin_awaiting_clear_current_${adminId}`);
  if (clearNonce && data !== `awaiting_confirm:${clearNonce}`) {
    const clearKey = `admin_awaiting_clear_${clearNonce}`, context = parseObject(await kv.get(clearKey));
    if (context?.messageId === messageId) {
      await kv.delete(clearKey); await kv.delete(`admin_awaiting_clear_current_${adminId}`);
    }
  }
  const pendingInput = parseObject(await kv.get(`admin_input_${adminId}`));
  if (data === "input_cancel") { await answerCallback(query, config, "已取消"); await cancelAdminInput(env, config, messageId); return; }
  if (pendingInput && messageId && pendingInput.originMenuId === messageId && data !== "list_page_info") await clearAdminInput(env, config);
  const importing = parseObject(await kv.get(`admin_restore_input_${adminId}`));
  if (importing && messageId && importing.messageId === messageId && !["backup_import", "backup_import_cancel"].includes(data)) await kv.delete(`admin_restore_input_${adminId}`);
  const contactDetail = data.match(/^contact_detail:([1-9]\d{0,19}):(recent|authed|awaiting|search|blacklist):(\d{1,6})$/);
  const listDetails = data.match(/^list_details:(recent|authed|awaiting|search|blacklist):(\d{1,6})$/);
  if (contactDetail || listDetails) {
    await answerCallback(query, config);
    const kind = contactDetail ? contactDetail[2] : listDetails[1], page = Number(contactDetail ? contactDetail[3] : listDetails[2]);
    const view = await buildContactListByKind(kind, page, env, config);
    const user = contactDetail && view?.entries.find((entry) => entry.id === contactDetail[1]);
    const returnButton = { text: "⬅️ 返回列表", callback_data: `list_style:compact:${kind}:${view?.page ?? page}` };
    if (!view || (contactDetail && !user)) { await renderAdminView("联系人记录已更新，请返回列表刷新", { inline_keyboard: [[returnButton]] }, env, config, messageId); return; }
    if (user) {
      const buttons = [];
      if (kind !== "blacklist" && !String(user.status || "").startsWith("🚫")) buttons.push([{ text: `💬 ${shortBlacklistName(compactContactName(user))}`, callback_data: `focus:${user.id}` }]);
      buttons.push([returnButton]);
      await renderAdminView(contactDetailsText(user), { inline_keyboard: buttons }, env, config, messageId);
    } else {
      const text = `${view.title}\n\n${view.entries.map((entry) => contactDetailsText(entry, true)).join("\n\n") || "暂无联系人"}`;
      await renderAdminView(text, { inline_keyboard: [view.entries.map((entry) => ({ text: shortBlacklistName(compactContactName(entry), 8), callback_data: `contact_detail:${entry.id}:${kind}:${view.page}` })).slice(0, 5), ...
        (view.entries.length > 5 ? [view.entries.slice(5).map((entry) => ({ text: shortBlacklistName(compactContactName(entry), 8), callback_data: `contact_detail:${entry.id}:${kind}:${view.page}` }))] : []), [returnButton]].filter((row) => row.length) }, env, config, messageId);
    }
    return;
  }
  const listStyle = data.match(/^list_style:(plain|rich|compact):(recent|authed|awaiting|search|blacklist):(\d{1,6})$/);
  if (listStyle) {
    await answerCallback(query, config);
    await kv.put(`ui_list_style_${adminId}`, "plain");
    const view = await buildContactListByKind(listStyle[2], Number(listStyle[3]), env, config);
    if (view) await renderContactList(view, env, config, messageId);
    else await renderAdminView("搜索已过期，请重新搜索", getBackToMenuButtons(), env, config, messageId);
    return;
  }
  if (await handleAdvancedCallback(query, data, env, config)) return;

  if (data === "contact_search" || data === "contact_note") {
    await answerCallback(query, config);
    const active = data === "contact_note" ? await getActiveAdminTarget(kv, adminId) : null;
    if (data === "contact_note" && !active) {
      await renderAdminView("请先选择联系人，或发送 /note ID 备注", getBackToMenuButtons(), env, config, messageId);
    } else {
      await requestAdminInput(data === "contact_search" ? "search" : "note", active?.userId, env, config, messageId);
    }
    return;
  }

  const searchPage = data.match(/^search_page:(\d{1,6})$/);
  if (searchPage) {
    await answerCallback(query, config);
    const queryText = await kv.get(`admin_search_${adminId}`);
    if (!queryText) { await renderAdminView("搜索已过期，请重新搜索", getBackToMenuButtons(), env, config, messageId); return; }
    const result = await buildContactSearch(kv, adminId, queryText, Number(searchPage[1]));
    await renderContactList(result, env, config, messageId);
    return;
  }

  const sessionSetting = data.match(/^session_set:(0|5|15|30|60)$/);
  if (data === "session_settings" || sessionSetting) {
    await answerCallback(query, config);
    if (sessionSetting) await kv.put(`settings_admin_${adminId}`, JSON.stringify({ idleMinutes: Number(sessionSetting[1]) }));
    const minutes = await getSessionIdleMinutes(kv, adminId);
    await editHtmlMessage(adminId, messageId, `⏱️ 会话自动退出\n当前：${minutes ? `${minutes} 分钟未发送消息` : "关闭"}`, config, { reply_markup: sessionSettingsButtons(minutes) });
    return;
  }

  if (data === "diagnostics") {
    await answerCallback(query, config);
    await showDiagnostics(env, config, messageId);
    return;
  }

  if (data === "status") {
    const stats = await collectKvStats(kv, adminId);
    const statusTxt = `📊 系统状态\n━━━━━━━━━━━━━━\n✅ 已授权访客：${stats.authCount}\n🕘 30天内活跃访客：${stats.recentCount}\n🚫 封禁中的用户：${stats.lockCount}\n🗂️ 当前数据条数：${stats.totalKeys}`;
    await answerCallback(query, config);
    await renderAdminView(escapeHtml(statusTxt), getBackToMenuButtons(), env, config, messageId);
    return;
  }

  const blacklistPage = data.match(/^blacklist_page:(\d{1,6})$/);
  if (data === "blacklist" || blacklistPage) {
    await answerCallback(query, config);
    const view = await buildBlacklistText(kv, config, blacklistPage ? Number(blacklistPage[1]) : 0);
    await renderContactList(view, env, config, messageId);
    return;
  }



  const authedPage = data.match(/^authed_page:(\d{1,6})$/);
  if (data === "authed" || authedPage) {
    await answerCallback(query, config);
    const authData = await buildAuthedUsersText(kv, adminId, config, authedPage ? Number(authedPage[1]) : 0);
    await renderContactList(authData, env, config, messageId);
    return;
  }

  const authedClearPage = data.match(/^authed_clear_expired:(\d{1,6})$/);
  if (data === "authed_clear_expired" || authedClearPage) {
    const count = await clearExpiredAuthed(kv, adminId);
    await answerCallback(query, config, `已清除 ${count} 个长期未互动的授权`, true);
    const authData = await buildAuthedUsersText(kv, adminId, config, authedClearPage ? Number(authedClearPage[1]) : 0);
    await renderContactList(authData, env, config, messageId);
    return;
  }

  const recentPage = data.match(/^recent_page:(\d{1,6})$/);
  if (data === "recent" || data === "recent_all" || recentPage) {
    await answerCallback(query, config);
    const recentData = await buildRecentUsersText(kv, recentPage ? Number(recentPage[1]) : 0);
    await renderContactList(recentData, env, config, messageId);
    return;
  }

  const recentClearPage = data.match(/^recent_clear_unverified:(\d{1,6})$/);
  if (data === "recent_clear_unverified" || recentClearPage) {
    const count = await clearUnverifiedRecent(kv);
    await answerCallback(query, config, `已清除 ${count} 个未验证访客`, true);
    const recentData = await buildRecentUsersText(kv, recentClearPage ? Number(recentClearPage[1]) : 0);
    await renderContactList(recentData, env, config, messageId);
    return;
  }

  if (data === "switch_menu") {
    const switchData = await buildSwitchDialog(kv, adminId);
    await answerCallback(query, config);
    await editHtmlMessage(adminId, messageId, switchData.text, config, { reply_markup: switchData.replyMarkup });
    return;
  }

  if (data === "menu_main") {
    await answerCallback(query, config);
    await renderAdminMenu(adminId, env, config, messageId);
    return;
  }

  // 来自控制台列表的切换：切换后刷新控制台
  // 来自访客通知的切换（nfocus）：只切换，不改动通知内容
  const focusMatch = data.match(/^(n?focus):(\d+)$/);
  if (focusMatch) {
    const [, kind, targetUserId] = focusMatch;
    const recentUser = await getRecentUserById(kv, targetUserId);
    const displayName = recentUser?.firstName || recentUser?.username || "这个访客";
    if (Number(await kv.get(`lock_${targetUserId}`)) > Date.now()) {
      await answerCallback(query, config, "该联系人正在封禁中", true);
      return;
    }
    await setActiveAdminTarget(kv, adminId, targetUserId, displayName);
    await answerCallback(query, config, `已切换到 ${displayName}`);
    if (kind === "focus") await renderAdminMenu(adminId, env, config, messageId);
    else {
      const currentMenu = parseObject(await kv.get(`ui_menu_${adminId}`));
      await renderAdminMenu(adminId, env, config, currentMenu?.messageId);
    }
    return;
  }

  if (data === "focus_clear") {
    await clearActiveAdminTarget(kv, adminId);
    await answerCallback(query, config, "已清除当前会话");
    await renderAdminMenu(adminId, env, config, messageId);
    return;
  }

  if (data === "clear") {
    const count = await autoMaintenanceSmartClear(kv, adminId);
    await answerCallback(query, config, `清理完成：共移除 ${count} 条临时或长期未互动的数据`, true);
    await renderAdminMenu(adminId, env, config, messageId);
    return;
  }

  // 未知回调（例如旧版本按钮），也要应答，避免按钮一直转圈
  await answerCallback(query, config, "这个按钮已失效，请发送 /admin 重新打开控制台");
}

function buildAdminButtons() {
  return {
    inline_keyboard: [
      [
        { text: "📊 系统状态", callback_data: "status" },
        { text: "✅ 已授权", callback_data: "authed" },
      ],
      [
        { text: "📁 黑名单", callback_data: "blacklist" },
        { text: "🕘 最近访客", callback_data: "recent" },
      ],
      [
        { text: "🔄 切换对话", callback_data: "switch_menu" },
        { text: "🧹 立即清理", callback_data: "clear" },
      ],
      [{ text: "🔎 搜索联系人", callback_data: "contact_search" }, { text: "📝 联系人备注", callback_data: "contact_note" }],
      [{ text: "📬 待回复", callback_data: "awaiting" }, { text: "⚡ 快捷回复", callback_data: "quick_replies" }],
      [{ text: "🌙 离开模式", callback_data: "away_settings" }, { text: "💾 数据备份", callback_data: "backups" }],
      [{ text: "⏱️ 会话设置", callback_data: "session_settings" }, { text: "🩺 运行诊断", callback_data: "diagnostics" }],
    ],
  };
}

async function buildSwitchDialog(kv, adminId) {
  const focusUsers = await getRecentFocusUsers(kv, 12, adminId);
  const activeTarget = await getActiveAdminTarget(kv, adminId);
  const currentSession = await currentContactHtml(kv, activeTarget);

  if (!focusUsers.length) {
    return { text: `🔄 切换对话（近30天）\n━━━━━━━━━━━━━━\n${currentSession}\n暂无可切换的联系人`, replyMarkup: getClearFocusButtons(true) };
  }
  return { text: `🔄 切换对话（近30天）\n━━━━━━━━━━━━━━\n${currentSession}`, replyMarkup: getFocusButtons(focusUsers, true, true) };
}

function getFocusButtons(users, includeClear = false, includeBack = false) {
  const rows = [];
  const limited = users.slice(0, BUTTON_USER_LIMIT);
  for (let i = 0; i < limited.length; i += 2) {
    rows.push(
      limited.slice(i, i + 2).map((user) => ({ text: truncateText(user.name || `访客${user.id}`, 8), callback_data: `focus:${user.id}` }))
    );
  }
  if (includeClear) rows.push([{ text: "清除当前会话", callback_data: "focus_clear" }]);
  if (includeBack) rows.push([{ text: "⬅️ 返回菜单", callback_data: "menu_main" }]);
  return { inline_keyboard: rows };
}

function getClearFocusButtons(includeBack = false) {
  const inlineKeyboard = [[{ text: "清除当前会话", callback_data: "focus_clear" }]];
  if (includeBack) inlineKeyboard.push([{ text: "⬅️ 返回菜单", callback_data: "menu_main" }]);
  return { inline_keyboard: inlineKeyboard };
}

function getBackToMenuButtons() {
  return { inline_keyboard: [[{ text: "⬅️ 返回菜单", callback_data: "menu_main" }]] };
}

async function buildAdminMenuText(env, config) {
  const adminNickname = await getAdminDisplayName(env, config);
  const activeTarget = await getActiveAdminTarget(env.BOT_KV, config.adminId);
  const currentSession = await currentContactHtml(env.BOT_KV, activeTarget);

  return `ฅ˙Ⱉ˙ฅ 管理员控制台\n━━━━━━━━━━━━━━\n${currentSession}\n━━━━━━━━━━━━━━\n💌 定向推送：/send ID 内容\n⛔ 管理操作：拉黑 / 解封 + ID\n🔁 撤销授权：撤销 + ID\n✉️ 会话回复：直接回复转发的消息\n👤 当前身份：${escapeHtml(adminNickname)}`;
}

async function renderAdminMenu(chatId, env, config, messageId) {
  await clearAdminInput(env, config);
  await retireAdminConfirmations(messageId, env, config);
  if (messageId) await invalidateQuickPanel(messageId, env, config);
  const text = await buildAdminMenuText(env, config);
  const replyMarkup = buildAdminButtons();

  const activeTarget = await getActiveAdminTarget(env.BOT_KV, config.adminId);
  if (activeTarget) {
    const user = await getRecentUserById(env.BOT_KV, activeTarget.userId);
    const username = String(user?.username || "").replace(/^@/, "");
    if (/^[A-Za-z0-9_]{1,64}$/.test(username)) {
      replyMarkup.inline_keyboard.push([{ text: "👤 查看当前联系人主页", url: `https://t.me/${username}` }]);
    }
  }

  return sendLatestUi(chatId, "menu", async () => {
    if (messageId) {
      const result = await editHtmlMessage(chatId, messageId, text, config, { reply_markup: replyMarkup });
      return result?.ok && !result.result?.message_id ? { ...result, result: { message_id: messageId } } : result;
    }
    return sendHtmlMessage(chatId, text, config, { reply_markup: replyMarkup });
  }, env, config, false, messageId || null);
}

async function sendAdminMenu(chatId, env, config) {
  const result = await renderAdminMenu(chatId, env, config);

  if (!result?.ok) {
    const reason = redactSensitiveInfo(
      result?.description || "接口未返回有效响应",
      env
    );
    throw new Error(`Telegram ${result?.error_code || ""}: ${reason}`);
  }

  return result;
}

// 管理员诊断信息中的真实 Token 和密钥必须隐藏。
function redactSensitiveInfo(value, env) {
  let text = String(value || "未知错误");
  for (const secret of [env.BOT_TOKEN, env.WEBHOOK_SECRET, env.TURNSTILE_SECRET]) {
    if (secret) text = text.split(String(secret)).join("[REDACTED]");
  }
  return text.replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]");
}

// ==========================================
// 数据维护
// ==========================================

/**
 * 手动清理：只清理临时数据和“长期未互动”的授权。
 * 不会删除 msg_ 映射（它们会按 TTL 自然过期），以免管理员无法回复旧消息。
 */
async function autoMaintenanceSmartClear(kv, adminId) {
  let count = 0;
  for (const prefix of ["rate_", "verify_msg_"]) {
    const keys = await listAllKeys(kv, prefix);
    for (const key of keys) {
      await kv.delete(key.name);
      count++;
    }
  }
  count += await clearExpiredAuthed(kv, adminId);
  return count;
}

/**
 * “过期授权”= 30 天内没有发过消息（无 recent_）且 180 天内管理员没有回复过（无 replied_）。
 * 刚验证、管理员还没来得及回复的新用户不会被误删。
 */
async function isAuthExpired(kv, userId) {
  const [replied, recent] = await Promise.all([kv.get(`replied_${userId}`), kv.get(`recent_${userId}`)]);
  return !replied && !recent;
}

async function clearExpiredAuthed(kv, adminId) {
  const authKeys = await listKeysByPrefix(kv, "auth_");
  let count = 0;
  for (const key of authKeys) {
    const userId = key.replace("auth_", "");
    if (userId === String(adminId)) continue;
    if (await isAuthExpired(kv, userId)) {
      await kv.delete(key);
      count++;
    }
  }
  return count;
}

async function clearUnverifiedRecent(kv) {
  let count = 0;

  const recentKeys = await listAllKeys(kv, "recent_");
  for (const key of recentKeys) {
    const raw = await kv.get(key.name);
    if (!raw) continue;
    try {
      const item = JSON.parse(raw);
      const auth = await kv.get(`auth_${item.id}`);
      if (auth !== "true") {
        await kv.delete(key.name);
        count++;
      }
    } catch {
      await kv.delete(key.name);
      count++;
    }
  }

  const pendingKeys = await listAllKeys(kv, "pending_");
  for (const key of pendingKeys) {
    await kv.delete(key.name);
    count++;
  }

  return count;
}

/**
 * Turnstile 健康检查：每小时最多执行一次。
 * 超过 24 小时没人验证通过，且最近 6 小时有 >=10 人卡在待验证，则提醒管理员。
 */
async function checkTurnstileHealth(env, config) {
  const kv = env.BOT_KV;
  if (await kv.get("health_check_last_run")) return;
  await kv.put("health_check_last_run", String(Date.now()), { expirationTtl: HEALTH_CHECK_INTERVAL_SEC });

  const lastVerified = Number((await kv.get("stats_last_verified_time")) || 0);
  if (!lastVerified) return; // 从未有人验证过，无参照，跳过

  const hoursSinceVerified = (Date.now() - lastVerified) / (1000 * 60 * 60);
  if (hoursSinceVerified < 24) return;

  const pendingCount = (await listAllKeys(kv, "pending_")).length;
  if (pendingCount >= 10) {
    await safeNotifyAdmin(env, config, `⚠️ Turnstile 可能出现故障\n已超过 ${Math.floor(hoursSinceVerified)} 小时无人验证通过，但最近有 ${pendingCount} 人在等待验证`);
  }
}

async function collectKvStats(kv, adminId = "") {
  const keys = await listAllKeys(kv);
  const values = await readMany(kv, keys.filter((key) => /^(auth|lock|recent)_/.test(key.name)).map((key) => key.name));
  const now = Date.now(); let authCount = 0, lockCount = 0, recentCount = 0;
  for (const key of keys) {
    if (key.name.startsWith("auth_") && key.name !== `auth_${adminId}` && values.get(key.name) === "true") authCount++;
    else if (key.name.startsWith("lock_") && Number(values.get(key.name)) > now) lockCount++;
    else if (key.name.startsWith("recent_")) {
      const recent = parseRecentUser(values.get(key.name));
      if (recent?.updatedAt > now - RECENT_USER_TTL * 1000 && recent.updatedAt <= now) recentCount++;
    }
  }
  return { authCount, lockCount, recentCount, totalKeys: keys.length };
}

async function listKeysByPrefix(kv, prefix) {
  const keys = await listAllKeys(kv, prefix);
  return keys.map((key) => key.name);
}

async function listAllKeys(kv, prefix = "") {
  const all = [];
  let cursor;
  do {
    const page = await kv.list({ prefix, cursor });
    all.push(...page.keys);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return all;
}

async function touchRecentUser(msg, chatId, now, env) {
  const previous = await getRecentUserById(env.BOT_KV, chatId);
  const payload = { id: chatId, firstName: msg.from?.first_name || previous?.firstName || "", username: msg.from ? msg.from.username || "" : previous?.username || "", updatedAt: now };
  await env.BOT_KV.put(`recent_${chatId}`, JSON.stringify(payload), { expirationTtl: RECENT_USER_TTL });
  await saveContactProfile(env.BOT_KV, chatId, payload);
}

// 身份资料独立于近30天活跃记录，保存昵称不会把旧联系人重新算成最近访客。
async function saveContactProfile(kv, userId, value) {
  const key = `profile_${userId}`, previous = parseObject(await kv.get(key)) || {};
  const firstName = Array.from(toSafeUnicode(value.firstName || previous.firstName || "")).slice(0, 100).join("");
  const username = typeof value.username === "string" ? value.username : previous.username || "";
  if (!firstName && !username) return;
  if (firstName === previous.firstName && username === previous.username) return;
  await kv.put(key, JSON.stringify({ id: String(userId), firstName, username, savedAt: Date.now() }));
}

async function migrateContactProfiles(kv) {
  for (const user of await loadRecentRecords(kv)) {
    if (user && /^[1-9]\d{0,19}$/.test(String(user.id))) await saveContactProfile(kv, user.id, user);
  }
}

// 在实时协调器的串行入口内消费限额；同一相册只消费一次。
async function checkAndConsumeRateLimit(chatId, now, env) {
  const key = `rate_${chatId}`;
  const raw = await env.BOT_KV.get(key);
  let state = { start: now, count: 0 };
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed.start === "number" && typeof parsed.count === "number") state = parsed;
    } catch {}
  }
  if (now - state.start >= RATE_LIMIT_WINDOW_MS) state = { start: now, count: 0 };
  if (state.count >= RATE_LIMIT_MAX_MESSAGES) {
    const retryAfter = Math.max(1, Math.ceil((RATE_LIMIT_WINDOW_MS - (now - state.start)) / 1000));
    return { blocked: true, retryAfter };
  }
  state.count += 1;
  await env.BOT_KV.put(key, JSON.stringify(state), { expirationTtl: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000) + 60 });
  return { blocked: false, retryAfter: 0 };
}

// ==========================================
// 列表展示
// ==========================================

// 名称只占一行；限制大致显示宽度，汉字和表情按两格计算。
function blacklistName(value) {
  return toSafeUnicode(value).replace(/[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f]/g, " ").replace(/[|｜]/g, " ").replace(/\s+/gu, " ").trim();
}
function blacklistProfile(value) {
  const firstName = truncateText(blacklistName(value?.firstName || value?.first_name || ""), 80);
  const username = String(value?.username || "").replace(/^@/, "");
  return { firstName, username: /^[A-Za-z0-9_]{1,64}$/.test(username) ? username : "" };
}
function shortBlacklistName(value, maxWidth = 16) {
  const text = blacklistName(value);
  const segments = typeof Intl.Segmenter === "function"
    ? [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((item) => item.segment)
    : Array.from(text);
  const width = (part) => /^[\x20-\x7e]+$/.test(part.normalize("NFKC")) ? part.normalize("NFKC").length : 2;
  if (segments.reduce((sum, part) => sum + width(part), 0) <= maxWidth) return text;
  let result = "", used = 0;
  for (const part of segments) {
    if (used + width(part) > maxWidth - 1) break;
    result += part; used += width(part);
  }
  return `${result}…`;
}
async function buildBlacklistText(kv, config, requestedPage = 0) {
  const keys = (await listAllKeys(kv, "lock_")).filter((key) => /^lock_\d{1,20}$/.test(key.name));
  const lockValues = await readMany(kv, keys.map((key) => key.name));
  const active = keys.map((key) => ({ ...key, until: Number(lockValues.get(key.name)), id: key.name.slice(5) }))
    .filter((key) => Number.isFinite(key.until) && key.until > Date.now())
    .sort((a, b) => b.until - a.until || a.id.localeCompare(b.id));
  const page = getListPage(active, requestedPage);
  const values = await readMany(kv, page.items.flatMap((item) => [`recent_${item.id}`, `note_${item.id}`]));
  const entries = [];
  const rows = await Promise.all(page.items.map(async (item) => {
    let profile = blacklistProfile(item.metadata);
    if (!profile.firstName && !profile.username) profile = blacklistProfile(parseRecentUser(values.get(`recent_${item.id}`)) || parseContactNote(values.get(`note_${item.id}`)));
    if (!profile.firstName && !profile.username) {
      try {
        const result = await safeJson(await callApi("getChat", { chat_id: item.id }, { ...config, apiTimeoutMs: 1500 }));
        if (result.ok) profile = blacklistProfile(result.result);
      } catch {}
      // 缓存旧版黑名单查询到的资料，但不刷新或延长封禁期限。
      if ((profile.firstName || profile.username) && item.until >= Date.now() + 60000) {
        try { await kv.put(item.name, String(item.until), { expiration: Math.ceil(item.until / 1000), metadata: profile }); }
        catch (error) { console.warn("黑名单资料缓存失败:", redactSensitiveInfo(error?.message || error, { BOT_TOKEN: config.botToken })); }
      }
    }
    entries.push({ ...item, ...profile, status: "🚫封禁中" });
    const label = shortBlacklistName(profile.firstName || (profile.username ? `@${profile.username}` : "未知访客"));
    return `• <code>${escapeHtml(item.id)}</code> | ${formatContactNameHtml(label, profile.username, item.id)}`;
  }));
  const navigation = [];
  if (page.page > 0) navigation.push({ text: "⬅️ 上一页", callback_data: `blacklist_page:${page.page - 1}` });
  if (page.pageCount > 1) navigation.push({ text: `${page.page + 1} / ${page.pageCount}`, callback_data: "list_page_info" });
  if (page.page + 1 < page.pageCount) navigation.push({ text: "下一页 ➡️", callback_data: `blacklist_page:${page.page + 1}` });
  const view = { text: rows.length ? `📁 黑名单列表 (30天自动销毁)\n━━━━━━━━━━━━━━\n${rows.join("\n")}` : "🍃 当前暂无封禁用户",
    replyMarkup: { inline_keyboard: [...(navigation.length ? [navigation] : []), ...getBackToMenuButtons().inline_keyboard] } };
  const profiles = new Map(entries.map((user) => [user.id, user]));
  return compactContactList(view, "blacklist", page, page.items.map((user) => profiles.get(user.id)), `🚫 黑名单（${active.length} 人）`, "当前暂无封禁用户");
}

// 文字列表保留昵称主页链接、数字 ID、分页与原来的会话切换按钮。
function compactContactName(user) {
  return blacklistName(user.firstName || user.displayName || user.name || "") ||
    (blacklistProfile(user).username ? `@${blacklistProfile(user).username}` : "未知访客");
}
function contactDetailsText(user, compact = false) {
  const name = compact ? shortBlacklistName(compactContactName(user), 12) : truncateText(compactContactName(user), 80);
  const time = user.until ? `封禁至 ${formatTimestamp(user.until)}` : user.updatedAt ? formatTimestamp(user.updatedAt) : "近30天无消息记录";
  const pending = user.pendingCount || user.count || 0;
  const note = user.note ? `\n📝 ${escapeHtml(compact ? truncateText(user.note, 20) : user.note)}` : "";
  return `${formatContactNameHtml(name, user.username, user.id)} | ${escapeHtml(user.status || "")}\n🆔 <code>${user.id}</code> | ${escapeHtml(time)}${user.userStatus ? `\n${escapeHtml(user.userStatus)}` : ""}${pending ? `\n📬 ${pending}${pending === 1000 ? "+" : ""} 条待回复` : ""}${note}`;
}
function compactContactList(view, kind, pagination, entries, title, empty = "暂无联系人") {
  const safeEntries = entries.filter((user) => /^[1-9]\d{0,19}$/.test(String(user.id)));
  return { ...view, kind, page: pagination.page, entries: safeEntries, title: escapeHtml(title),
    compactText: escapeHtml(title) + (safeEntries.length ? "" : `\n\n${escapeHtml(empty)}`) };
}
async function buildContactListByKind(kind, page, env, config) {
  const kv = env.BOT_KV;
  if (kind === "recent") return buildRecentUsersText(kv, page);
  if (kind === "authed") return buildAuthedUsersText(kv, config.adminId, config, page);
  if (kind === "awaiting") return buildAwaitingList(kv, config.adminId, page);
  if (kind === "blacklist") return buildBlacklistText(kv, config, page);
  const search = kind === "search" && await kv.get(`admin_search_${config.adminId}`);
  return search ? buildContactSearch(kv, config.adminId, search, page) : null;
}
async function renderContactList(view, env, config, messageId = null) {
  // 所有旧显示偏好统一回到文字列表，不添加复制、资料或样式切换按钮。
  return renderAdminView(view.text, view.replyMarkup, env, config, messageId);
}

async function loadRecentRecords(kv) {
  const keys = await listAllKeys(kv, "recent_");
  const values = await readMany(kv, keys.map((key) => key.name));
  const records = [];
  for (const key of keys) {
    const raw = values.get(key.name);
    if (!raw) continue;
    try { records.push(JSON.parse(raw)); } catch {}
  }
  return records;
}

async function readMany(kv, keys) {
  const result = new Map();
  for (let offset = 0; offset < keys.length; offset += 100) {
    const batch = keys.slice(offset, offset + 100);
    if (kv.supportsBulkReads) {
      const values = await kv.get(batch, "text");
      for (const key of batch) result.set(key, values.get(key) ?? null);
    } else {
      const values = await Promise.all(batch.map((key) => kv.get(key)));
      batch.forEach((key, index) => result.set(key, values[index]));
    }
  }
  return result;
}

function normalizeTimestamp(value) {
  const timestamp = typeof value === "number" || /^\d+$/.test(String(value || "")) ? Number(value) : Date.parse(String(value || ""));
  return Number.isFinite(timestamp) && timestamp > 0 && timestamp <= 8640000000000000 ? timestamp : 0;
}

function parseRecentUser(raw) {
  try {
    const user = JSON.parse(raw);
    return user && typeof user === "object" && !Array.isArray(user) ? { ...user, updatedAt: normalizeTimestamp(user.updatedAt) } : null;
  } catch { return null; }
}

async function loadUserStatuses(kv, ids) {
  const days = await getAwaitingDays(kv);
  const values = await readMany(kv, ids.flatMap((id) => [`replied_${id}`, `lock_${id}`, `auth_${id}`, `inbox_${id}`]));
  return new Map(ids.map((id) => [String(id), {
    hasReplied: values.get(`replied_${id}`) === "true",
    pendingCount: parseInbox(values.get(`inbox_${id}`), days).pendingIds.length,
    status: Number(values.get(`lock_${id}`)) > Date.now() ? "🚫锁定" : values.get(`auth_${id}`) === "true" ? "✅已授权" : "⌛待验证",
  }]));
}

function getListPage(items, requestedPage) {
  const pageCount = Math.max(1, Math.ceil(items.length / LIST_PAGE_SIZE));
  const page = Math.min(pageCount - 1, Math.max(0, Number.isSafeInteger(requestedPage) ? requestedPage : 0));
  return { page, pageCount, items: items.slice(page * LIST_PAGE_SIZE, (page + 1) * LIST_PAGE_SIZE) };
}

function getVisitorListButtons(users, kind, pagination, cleanupButton) {
  const replyMarkup = getFocusButtons(users);
  const navigation = [];
  if (pagination.page > 0) navigation.push({ text: "⬅️ 上一页", callback_data: `${kind}_page:${pagination.page - 1}` });
  navigation.push({ text: `${pagination.page + 1} / ${pagination.pageCount}`, callback_data: "list_page_info" });
  if (pagination.page + 1 < pagination.pageCount) navigation.push({ text: "下一页 ➡️", callback_data: `${kind}_page:${pagination.page + 1}` });
  replyMarkup.inline_keyboard.push(navigation);
  if (cleanupButton) replyMarkup.inline_keyboard.push([cleanupButton]);
  replyMarkup.inline_keyboard.push([{ text: "清除当前会话", callback_data: "focus_clear" }], [{ text: "⬅️ 返回菜单", callback_data: "menu_main" }]);
  return replyMarkup;
}

async function buildRecentUsersText(kv, requestedPage = 0) {
  const records = (await loadRecentRecords(kv))
    .filter((item) => item && typeof item === "object" && !Array.isArray(item) && /^\d{1,20}$/.test(String(item.id || "")))
    .map((item) => ({ ...item, id: String(item.id), updatedAt: normalizeTimestamp(item.updatedAt) }))
    .filter((item) => item.updatedAt > Date.now() - RECENT_USER_TTL * 1000 && item.updatedAt <= Date.now());
  if (!records.length) {
    return compactContactList({ text: "🕘 最近访客\n━━━━━━━━━━━━━━\n还没有近 30 天的访客记录", replyMarkup: getBackToMenuButtons() }, "recent", getListPage([], 0), [], "🕘 最近访客（近30天）", "还没有近30天的访客记录");
  }

  const statuses = await loadUserStatuses(kv, records.map((item) => item.id));
  const recordsWithStatus = records.map((item) => ({ ...item, ...statuses.get(item.id) }));

  // 当前待回复优先，然后按时间倒序
  recordsWithStatus.sort((a, b) => {
    if (!!a.pendingCount === !!b.pendingCount) return (b.updatedAt || 0) - (a.updatedAt || 0);
    return a.pendingCount ? -1 : 1;
  });

  const pagination = getListPage(recordsWithStatus, requestedPage);
  const top = pagination.items;
  const unverifiedCount = recordsWithStatus.filter((item) => item.status === "⌛待验证").length;

  const buttonUsers = top.map((item) => ({ id: String(item.id), name: item.firstName || item.username || `访客${item.id}` }));
  const notes = await readMany(kv, top.map((item) => `note_${item.id}`));
  const lines = top.map((item) => {
    const name = truncateText(item.firstName || "未知用户", 6);
    const badge = item.pendingCount ? "📬 " : "";
    const note = parseContactNote(notes.get(`note_${item.id}`));
    return `${badge}${formatContactNameHtml(name, item.username, item.id)}｜${escapeHtml(item.status)}｜${escapeHtml(formatTimestamp(item.updatedAt))}\n🆔 <code>${escapeHtml(item.id)}</code>${note?.text ? `\n📝 ${escapeHtml(note.text)}` : ""}`;
  });

  const title = `🕘 最近访客（近30天，共 ${recordsWithStatus.length} 人）\n━━━━━━━━━━━━━━`;
  const cleanupButton = unverifiedCount > 0
    ? { text: `🗑️ 清除未验证 (${unverifiedCount}人)`, callback_data: `recent_clear_unverified:${pagination.page}` } : null;
  const replyMarkup = getVisitorListButtons(buttonUsers, "recent", pagination, cleanupButton);

  return compactContactList({ text: `${title}\n${lines.join("\n\n")}`, replyMarkup }, "recent", pagination,
    top.map((user) => ({ ...user, note: parseContactNote(notes.get(`note_${user.id}`))?.text || "" })), `🕘 最近访客（近30天，${recordsWithStatus.length} 人）`);
}

async function buildAuthedUsersText(kv, adminId, config, requestedPage = 0) {
  const authKeys = await listKeysByPrefix(kv, "auth_");
  const authValues = await readMany(kv, authKeys);
  const userIds = authKeys.filter((key) => authValues.get(key) === "true").map((key) => key.replace("auth_", "")).filter((userId) => /^[1-9]\d{0,19}$/.test(userId) && userId !== String(adminId));
  if (!userIds.length) return compactContactList({ text: "✅ 已授权访客\n━━━━━━━━━━━━━━\n当前没有已授权访客", replyMarkup: getBackToMenuButtons() }, "authed", getListPage([], 0), [], "✅ 已授权访客", "当前没有已授权访客");

  // 先读取全部 KV 状态并排序，再取当前页
  const values = await readMany(kv, userIds.flatMap((id) => [`replied_${id}`, `recent_${id}`, `inbox_${id}`, `profile_${id}`, `note_${id}`]));
  const awaitingDays = await getAwaitingDays(kv);
  const users = userIds.map((userId) => {
      const replied = values.get(`replied_${userId}`), recentUser = parseRecentUser(values.get(`recent_${userId}`));
      return {
        id: userId,
        recentUser,
        profile: parseObject(values.get(`profile_${userId}`)),
        noteProfile: parseContactNote(values.get(`note_${userId}`)),
        updatedAt: recentUser?.updatedAt || 0,
        hasReplied: replied === "true",
        pendingCount: parseInbox(values.get(`inbox_${userId}`), awaitingDays).pendingIds.length,
        isExpired: !replied && !recentUser,
      };
    });

  users.sort((a, b) => {
    if (!!a.pendingCount === !!b.pendingCount) return (b.updatedAt || 0) - (a.updatedAt || 0);
    return a.pendingCount ? -1 : 1;
  });

  const expiredCount = users.filter((u) => u.isExpired).length;
  const pagination = getListPage(users, requestedPage);
  const top = pagination.items;

  // 只对展示中、且没有本地昵称的用户调用 getChat
  await Promise.all(
    top.map(async (user) => {
      user.displayName = user.recentUser?.firstName || user.profile?.firstName || user.noteProfile?.firstName || user.recentUser?.username || user.profile?.username || user.noteProfile?.username || null;
      user.username = user.recentUser ? user.recentUser.username || "" : user.profile ? user.profile.username || "" : user.noteProfile?.username || "";
      user.userStatus = null;
      if (user.displayName) { if (!user.profile) await saveContactProfile(kv, user.id, { firstName: user.displayName, username: user.username }); return; }
      try {
        const data = await safeJson(await callApi("getChat", { chat_id: user.id }, { ...config, apiTimeoutMs: 1500 }));
        if (data.ok && data.result) {
          user.displayName = data.result.first_name || data.result.username || `访客${user.id}`;
          user.username = data.result.username || "";
          await saveContactProfile(kv, user.id, { firstName: data.result.first_name || "", username: user.username });
        } else {
          const errorDesc = (data.description || "").toLowerCase();
          user.displayName = `访客${user.id}`;
          if (errorDesc.includes("bot was blocked")) user.userStatus = "已屏蔽";
          else if (errorDesc.includes("user is deactivated") || errorDesc.includes("user not found")) user.userStatus = "账号已注销";
          else if (errorDesc.includes("chat not found")) user.userStatus = "会话不存在";
        }
      } catch {
        user.displayName = `访客${user.id}`;
      }
    })
  );

  const notes = await readMany(kv, top.map((user) => `note_${user.id}`));
  const rows = top.map((user) => {
    const time = user.userStatus || (user.updatedAt ? formatTimestamp(user.updatedAt) : "30天内无消息");
    const badge = user.pendingCount ? "📬 " : "";
    const note = parseContactNote(notes.get(`note_${user.id}`));
    return `${badge}${formatContactNameHtml(truncateText(user.displayName, 8), user.username, user.id)}｜✅已授权｜${escapeHtml(time)}\n🆔 <code>${escapeHtml(user.id)}</code>${note?.text ? `\n📝 ${escapeHtml(note.text)}` : ""}`;
  });
  const buttonUsers = top.map((user) => ({ id: String(user.id), name: user.displayName }));

  const cleanupButton = expiredCount > 0
    ? { text: `🗑️ 清除长期未互动 (${expiredCount}人)`, callback_data: `authed_clear_expired:${pagination.page}` } : null;
  const replyMarkup = getVisitorListButtons(buttonUsers, "authed", pagination, cleanupButton);
  return compactContactList({ text: `✅ 已授权访客（共 ${users.length} 人）\n━━━━━━━━━━━━━━\n${rows.join("\n\n")}`, replyMarkup }, "authed", pagination,
    top.map((user) => ({ ...user, status: "✅已授权", note: parseContactNote(notes.get(`note_${user.id}`))?.text || "" })), `✅ 已授权访客（${users.length} 人）`);
}

async function getRecentFocusUsers(kv, limit = 6, adminId = "") {
  const now = Date.now();
  const cutoff = now - RECENT_USER_TTL * 1000;
  const timeOf = (value) => {
    const time = typeof value === "number" || /^\d+$/.test(String(value || "")) ? Number(value) : Date.parse(String(value || ""));
    return Number.isFinite(time) && time > 0 && time <= now ? time : 0;
  };
  const records = (await loadRecentRecords(kv))
    .filter((item) => item && typeof item === "object" && !Array.isArray(item) && /^\d{1,20}$/.test(String(item.id || "")));
  const contacts = new Map(records.map((item) => [String(item.id), { ...item, updatedAt: timeOf(item.updatedAt) }]));
  // 新记录保存沟通时间；旧记录按本项目一直使用的 180 天 TTL 恢复写入时间。
  for (const key of await listAllKeys(kv, "replied_")) {
    const id = key.name.slice("replied_".length);
    if (!/^\d{1,20}$/.test(id)) continue;
    const adminUpdatedAt = timeOf(key.metadata?.updatedAt) || timeOf((Number(key.expiration) - IMMUNITY_TTL) * 1000);
    if (adminUpdatedAt < cutoff) continue;
    contacts.set(id, { ...(contacts.get(id) || { id, updatedAt: 0 }), adminUpdatedAt });
  }
  const candidates = [...contacts.values()].filter((item) => String(item.id) !== String(adminId) && Math.max(item.updatedAt, item.adminUpdatedAt || 0) >= cutoff);
  const statuses = await loadUserStatuses(kv, candidates.map((item) => String(item.id)));
  const checked = candidates.map((item) => {
    const { status, hasReplied } = statuses.get(String(item.id));
    const updatedAt = Math.max(item.updatedAt, hasReplied ? item.adminUpdatedAt || 0 : 0);
    return { ...item, updatedAt, eligible: updatedAt >= cutoff && status !== "🚫锁定" && (status === "✅已授权" || hasReplied) };
  });
  const users = checked.filter((item) => item.eligible);
  users.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
  return users.slice(0, limit).map((item) => ({ id: String(item.id), name: item.firstName || item.username || `访客${item.id}` }));
}

// ==========================================
// 工具函数
// ==========================================

function formatTimestamp(timestamp) {
  if (!timestamp) return "未知时间";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(timestamp));
}

async function safeNotifyAdmin(env, config, text) {
  try { await sendMessage(config.adminId, redactSensitiveInfo(text, env), env, config); }
  catch (error) { console.error(redactSensitiveInfo(error?.message || error, env)); }
}

async function getAdminDisplayName(env, config) {
  const cacheKey = `cache_admin_name_${config.adminId}`;
  try {
    const cached = await env.BOT_KV.get(cacheKey);
    if (cached) return cached;
    const data = await safeJson(await callApi("getChat", { chat_id: config.adminId }, { ...config, apiTimeoutMs: 1500 }));
    if (data.ok && data.result) {
      const chat = data.result;
      const displayName = chat.first_name || chat.title || (chat.username ? `@${chat.username}` : "") || "管理员";
      await env.BOT_KV.put(cacheKey, displayName, { expirationTtl: ADMIN_NAME_CACHE_TTL });
      return displayName;
    }
  } catch (error) { console.error(redactSensitiveInfo(error?.message || error, env)); }
  return "管理员";
}

async function getUserSimpleStatus(userId, kv) {
  const lockUntil = Number((await kv.get(`lock_${userId}`)) || 0);
  if (lockUntil && Date.now() < lockUntil) return "🚫锁定";
  const auth = await kv.get(`auth_${userId}`);
  if (auth === "true") return "✅已授权";
  return "⌛待验证";
}

async function getRecentUserById(kv, userId) {
  const raw = await kv.get(`recent_${userId}`);
  const recent = parseRecentUser(raw);
  if (recent) return recent;
  const profile = parseObject(await kv.get(`profile_${userId}`));
  return profile ? { ...profile, updatedAt: 0 } : null;
}

async function setActiveAdminTarget(kv, adminId, userId, name) {
  await kv.put(`active_admin_${adminId}`, JSON.stringify({ userId: String(userId), name: String(name || userId), updatedAt: Date.now() }), { expirationTtl: ACTIVE_TARGET_TTL });
}

async function getActiveAdminTarget(kv, adminId) {
  const raw = await kv.get(`active_admin_${adminId}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed?.userId) return null;
    const minutes = await getSessionIdleMinutes(kv, adminId);
    const timestamp = Number(parsed.updatedAt);
    if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp > Date.now() || (minutes && Date.now() - timestamp >= minutes * 60000)) {
      await clearActiveAdminTarget(kv, adminId);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function clearActiveAdminTarget(kv, adminId) {
  await kv.delete(`active_admin_${adminId}`);
}

async function getSessionIdleMinutes(kv, adminId) {
  try {
    const value = JSON.parse(await kv.get(`settings_admin_${adminId}`));
    const minutes = value?.idleMinutes;
    if (Number.isInteger(minutes) && minutes >= 0 && minutes <= 1440) return minutes;
  } catch {}
  return DEFAULT_SESSION_IDLE_MINUTES;
}

function sessionSettingsButtons(current) {
  const choices = [5, 15, 30, 60, 0].map((minutes) => ({ text: `${minutes === current ? "✓ " : ""}${minutes ? `${minutes} 分钟` : "关闭"}`, callback_data: `session_set:${minutes}` }));
  return { inline_keyboard: [choices.slice(0, 2), choices.slice(2, 4), choices.slice(4), ...getBackToMenuButtons().inline_keyboard] };
}

function parseContactNote(raw) {
  if (!raw) return null;
  try {
    const note = JSON.parse(raw);
    if (note && typeof note === "object" && !Array.isArray(note) && typeof note.text === "string") return note;
  } catch {}
  return null;
}

async function contactNoteLine(kv, userId) {
  const note = parseContactNote(await kv.get(`note_${userId}`));
  return note?.text ? `\n📝 ${escapeHtml(note.text)}` : "";
}

async function currentContactHtml(kv, active) {
  if (!active) return "💞 当前对话联系人：未选择";
  const user = await getRecentUserById(kv, active.userId);
  return `💞 <b>当前对话联系人：</b>${formatContactNameHtml(active.name, user?.username, active.userId)}\n🆔 联系人 ID：<code>${escapeHtml(active.userId)}</code>${await contactNoteLine(kv, active.userId)}`;
}

async function saveContactNote(userId, text, env, config, originMenuId = null) {
  if (!/^\d{1,20}$/.test(String(userId)) || String(userId) === config.adminId) {
    await inputNotice("请输入访客的数字 ID", env, config, originMenuId); return false;
  }
  const noteText = toSafeUnicode(text).trim();
  if (!noteText || Array.from(noteText).length > 80) {
    await inputNotice("备注请填写 1–80 个字符；输入 - 可删除备注", env, config, originMenuId); return false;
  }
  const key = `note_${userId}`;
  if (noteText === "-") await env.BOT_KV.delete(key);
  else {
    const recent = await getRecentUserById(env.BOT_KV, userId);
    const previous = parseContactNote(await env.BOT_KV.get(key));
    await env.BOT_KV.put(key, JSON.stringify({ text: noteText, firstName: recent?.firstName || previous?.firstName || "", username: recent ? recent.username || "" : previous?.username || "", updatedAt: Date.now() }));
  }
  await renderAdminView(`${noteText === "-" ? "🗑️ 备注已删除" : "📝 备注已保存"}\n🆔 <code>${escapeHtml(userId)}</code>${noteText === "-" ? "" : `\n${escapeHtml(noteText)}`}`, getBackToMenuButtons(), env, config, originMenuId);
  return true;
}

async function requestAdminInput(kind, targetId, env, config, originMenuId = null) {
  return beginAdminInput(kind, targetId, env, config, originMenuId);
}

async function beginAdminInput(kind, targetId, env, config, originMenuId = null) {
  await clearAdminInput(env, config);
  if (await env.BOT_KV.get(`admin_restore_input_${config.adminId}`)) await env.BOT_KV.delete(`admin_restore_input_${config.adminId}`);
  const prompt = kind === "search" ? "🔎 输入昵称、用户名、备注或 ID" : kind === "note" ? `📝 输入联系人 ${targetId} 的备注，输入 - 可删除` : kind === "quick_add" ? "输入：标题 | 回复内容" : "输入离开提示（最多 500 字）";
  const title = kind === "search" ? "🔎 搜索联系人" : kind === "note" ? "📝 修改联系人备注" : kind === "quick_add" ? "➕ 添加回复模板" : "✏️ 修改离开提示";
  let menuId = originMenuId;
  if (menuId) {
    const page = await renderAdminView(title, inputCancelButtons(), env, config, menuId);
    if (page?.ok) menuId = page.result?.message_id || menuId;
  }
  let result;
  try { result = await sendMessage(config.adminId, prompt, env, config, { reply_markup: { force_reply: true, input_field_placeholder: kind === "search" ? "搜索联系人" : kind === "note" ? "仅管理员可见的备注" : kind === "quick_add" ? "标题 | 回复内容" : "离开提示" } }); }
  catch (error) { result = { ok: false }; console.warn("管理输入未打开:", redactSensitiveInfo(error?.message || error, env)); }
  if (result.ok && result.result?.message_id) {
    await env.BOT_KV.put(`admin_input_${config.adminId}`, JSON.stringify({ kind, targetId, messageId: result.result.message_id, originMenuId: menuId }), { expirationTtl: 600 });
    await env.BOT_KV.put(`admin_prompt_${config.adminId}_${result.result.message_id}`, "true", { expirationTtl: MSG_MAP_TTL });
  } else {
    const retry = kind === "search" ? "contact_search" : kind === "note" ? "contact_note" : kind;
    await renderAdminView("⚠️ 未能打开输入框，请重试", { inline_keyboard: [[{ text: "重试", callback_data: retry }], ...getBackToMenuButtons().inline_keyboard] }, env, config, menuId);
  }
}

async function handleAdminTools(msg, text, env, config) {
  const kv = env.BOT_KV, adminId = config.adminId;
  if (await handleAdvancedAdminTools(msg, text, env, config)) return true;
  const commandMatch = text.match(/^\/(note|search|session|diagnose|cancel|list)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/i);
  if (commandMatch) {
    const action = commandMatch[1].toLowerCase(), args = (commandMatch[2] || "").trim();
    if (action === "list") {
      if (args && !/^(plain|rich|compact)$/i.test(args)) { await inputNotice("用法：/list", env, config); return true; }
      if (args) await kv.put(`ui_list_style_${adminId}`, "plain");
      await clearAdminInput(env, config);
      await renderContactList(await buildRecentUsersText(kv), env, config);
      return true;
    }
    if (action === "cancel") { await cancelAdminInput(env, config); return true; }
    if (action === "diagnose") { await showDiagnostics(env, config); return true; }
    if (action === "search") {
      if (args) {
        if (await sendContactSearch(args, env, config, null, msg.message_id)) await clearAdminInput(env, config);
      } else await requestAdminInput("search", null, env, config);
      return true;
    }
    if (action === "session") {
      if (args) {
        const minutes = /^(off|关闭)$/i.test(args) ? 0 : /^\d{1,4}$/.test(args) ? Number(args) : -1;
        if (minutes < 0 || minutes > 1440) { await sendMessage(adminId, "用法：/session 30（分钟）或 /session off", env, config); return true; }
        await kv.put(`settings_admin_${adminId}`, JSON.stringify({ idleMinutes: minutes }));
      }
      const minutes = await getSessionIdleMinutes(kv, adminId);
      await sendHtmlMessage(adminId, `⏱️ 会话自动退出：${minutes ? `${minutes} 分钟未发送消息` : "关闭"}`, config, { reply_markup: sessionSettingsButtons(minutes) });
      return true;
    }
    const explicit = args.match(/^(\d{1,20})\s+([\s\S]+)$/);
    const targetId = explicit?.[1] || (msg.reply_to_message ? await kv.get(`msg_${msg.reply_to_message.message_id}`) : (await getActiveAdminTarget(kv, adminId))?.userId);
    if (!targetId) { await sendMessage(adminId, "用法：/note ID 备注，或回复访客消息发送 /note 备注", env, config); return true; }
    const content = explicit?.[2] || args;
    if (content) await saveContactNote(targetId, content, env, config);
    else await requestAdminInput("note", targetId, env, config);
    return true;
  }
  if (msg.reply_to_message) {
    let pending;
    try { pending = JSON.parse(await kv.get(`admin_input_${adminId}`)); } catch {}
    if (pending?.messageId === msg.reply_to_message.message_id) {
      if (!text || text.startsWith("/")) { await inputNotice("请回复文字，或发送 /cancel 取消", env, config, pending.originMenuId); return true; }
      const completed = pending.kind === "search"
        ? await sendContactSearch(text, env, config, pending.originMenuId, msg.message_id)
        : pending.kind === "note" ? await saveContactNote(pending.targetId, text, env, config, pending.originMenuId) : false;
      if (completed) await clearAdminInput(env, config);
      return true;
    }
  }
  return false;
}

function normalizeSearch(value) { return toSafeUnicode(value).normalize("NFKC").toLocaleLowerCase().trim().replace(/^@/, ""); }

async function buildContactSearch(kv, adminId, text, requestedPage = 0) {
  const query = normalizeSearch(text);
  const [records, authKeys, replyKeys, noteKeys] = await Promise.all([loadRecentRecords(kv), listAllKeys(kv, "auth_"), listAllKeys(kv, "replied_"), listAllKeys(kv, "note_")]);
  const contacts = new Map(records.filter((record) => record && /^\d{1,20}$/.test(String(record.id))).map((record) => [String(record.id), { ...record, id: String(record.id) }]));
  for (const [keys, prefix] of [[authKeys, "auth_"], [replyKeys, "replied_"], [noteKeys, "note_"]]) {
    for (const key of keys) {
      const id = key.name.slice(prefix.length);
      if (/^\d{1,20}$/.test(id) && !contacts.has(id)) contacts.set(id, { id, updatedAt: 0 });
    }
  }
  contacts.delete(String(adminId));
  const noteValues = await readMany(kv, [...contacts.keys()].flatMap((id) => [`note_${id}`, `profile_${id}`]));
  const matched = [...contacts.values()].map((user) => {
    const note = parseContactNote(noteValues.get(`note_${user.id}`));
    const profile = parseObject(noteValues.get(`profile_${user.id}`));
    return { ...user, firstName: user.firstName || profile?.firstName || note?.firstName || "", username: typeof user.username === "string" ? user.username : profile ? profile.username || "" : note?.username || "", note: note?.text || "" };
  }).filter((user) => [user.id, user.firstName, user.username, user.note].some((value) => normalizeSearch(value).includes(query)));
  matched.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0) || a.id.localeCompare(b.id));
  const page = getListPage(matched, requestedPage), statuses = await loadUserStatuses(kv, page.items.map((user) => user.id));
  const lines = page.items.map((user) => `${formatContactNameHtml(user.firstName || user.username || `访客${user.id}`, user.username, user.id)}｜${escapeHtml(statuses.get(user.id)?.status || "⌛待验证")}\n🆔 <code>${escapeHtml(user.id)}</code>${user.note ? `\n📝 ${escapeHtml(user.note)}` : ""}`);
  const buttons = getVisitorListButtons(page.items.map((user) => ({ id: user.id, name: user.firstName || user.username || `访客${user.id}` })), "search", page);
  return compactContactList({ text: `🔎 搜索：${escapeHtml(text)}（${matched.length} 人）\n━━━━━━━━━━━━━━\n${lines.join("\n\n") || "没有找到联系人"}`, replyMarkup: buttons }, "search", page,
    page.items.map((user) => ({ ...user, ...statuses.get(user.id) })), `🔎 搜索：${text}（${matched.length} 人）`, "没有找到联系人");
}

async function sendContactSearch(text, env, config, originMenuId = null, queryMessageId = null) {
  const query = toSafeUnicode(text).trim();
  if (!query || Array.from(query).length > 64) { await inputNotice("搜索关键词请填写 1–64 个字符", env, config, originMenuId); return false; }
  await env.BOT_KV.put(`admin_search_${config.adminId}`, query, { expirationTtl: 900 });
  const result = await buildContactSearch(env.BOT_KV, config.adminId, query);
  const rendered = await renderContactList(result, env, config, originMenuId);
  if (!rendered?.ok) return false;
  // 结果已经显示后清理管理员搜索输入；删除失败不撤回结果或触发整次搜索重投。
  if (Number.isSafeInteger(queryMessageId) && queryMessageId > 0) {
    try {
      const deleted = await deleteMessage(config.adminId, queryMessageId, { ...config, apiTimeoutMs: 1500 });
      if (!deleted.ok && !/message to delete not found/i.test(deleted.description || "")) console.warn("搜索输入清理失败:", redactSensitiveInfo(deleted.description, env));
    }
    catch (error) { console.warn("搜索输入清理失败:", redactSensitiveInfo(error?.message || error, env)); }
  }
  return true;
}

async function showDiagnostics(env, config, messageId) {
  const runtime = config.runtime;
  const snapshot = runtime ? await runtime.diagnostics() : null;
  let webhook;
  try { webhook = await safeJson(await callApi("getWebhookInfo", {}, config)); }
  catch (error) { webhook = { ok: false, description: redactSensitiveInfo(error?.message || error, env) }; }
  const info = webhook.ok ? webhook.result || {} : null;
  const stats = snapshot?.stats || {};
  const lines = ["🩺 运行诊断", "━━━━━━━━━━━━━━", `实时状态：${runtime ? "已启用" : "未启用"}`,
    `最近请求：${stats.lastRequestAt ? formatTimestamp(stats.lastRequestAt) : "暂无"}`,
    `最近处理：${Number(stats.lastRequestMs) || 0} ms｜HTTP ${stats.lastRequestStatus || "—"}`,
    `接口平均耗时：${stats.apiCount ? Math.round(stats.apiTotalMs / stats.apiCount) : 0} ms（最近最多 100 次）`,
    `待同步数据：${snapshot?.mirrors ?? "未知"}${snapshot?.mirrors >= 1000 ? "+" : ""}`,
    `待处理相册：${snapshot?.albums ?? "未知"}｜失败/结果待确认：${snapshot?.failedAlbums ?? "未知"}`,
    `Webhook：${info ? (info.url ? "已设置" : "未设置") : "查询失败"}`];
  if (info) {
    lines.push(`待投递更新：${Number(info.pending_update_count) || 0}`);
    if (Array.isArray(info.allowed_updates) && info.allowed_updates.length && !info.allowed_updates.includes("edited_message")) lines.push("编辑通知：Webhook 未订阅 edited_message");
    if (info.last_error_message) lines.push(`上次投递错误：${formatTimestamp(Number(info.last_error_date) * 1000)}\n${redactSensitiveInfo(info.last_error_message, env)}`);
  } else lines.push(redactSensitiveInfo(webhook.description, env));
  const failures = (stats.failures || []).slice(-3).reverse();
  lines.push("━━━━━━━━━━━━━━", failures.length ? "最近失败：" : "暂无已记录的失败");
  for (const failure of failures) lines.push(`${formatTimestamp(failure.at)}｜${failure.label}\n${failure.reason}`);
  const buttons = { inline_keyboard: [[{ text: "🔄 刷新", callback_data: "diagnostics" }], ...getBackToMenuButtons().inline_keyboard] };
  const html = escapeHtml(redactSensitiveInfo(lines.join("\n"), env));
  await renderAdminView(html, buttons, env, config, messageId);
}

async function safeJson(response) {
  try { return await response.json(); } catch { return { ok: false, description: "接口返回了无法解析的响应" }; }
}

function parseObject(raw) {
  try { const value = JSON.parse(raw); return value && typeof value === "object" && !Array.isArray(value) ? value : null; } catch { return null; }
}

function parseArray(raw) {
  try { const value = JSON.parse(raw); return Array.isArray(value) ? value : []; } catch { return []; }
}

async function getAwaitingDays(kv) {
  const days = Number(await kv.get("settings_awaiting"));
  return [3, 5, 7].includes(days) ? days : 0;
}

function parseInbox(raw, days = 0, now = Date.now()) {
  const value = parseObject(raw) || {};
  const ids = Array.isArray(value.pendingIds) ? [...new Set(value.pendingIds.filter(Number.isSafeInteger))].slice(-1000) : [];
  const times = value.pendingAt && typeof value.pendingAt === "object" ? value.pendingAt : {};
  const pendingIds = [], pendingAt = {}, clearedIds = Array.isArray(value.clearedIds) ? value.clearedIds.filter(Number.isSafeInteger) : [];
  for (const id of ids) {
    // 旧记录没有逐条时间，保守使用最后一次收到消息的时间。
    const at = normalizeTimestamp(times[id]) || normalizeTimestamp(value.incomingAt) || now;
    if (days && at <= now - days * 86400000) { clearedIds.push(id); continue; }
    pendingIds.push(id); pendingAt[id] = at;
  }
  return { ...value, pendingIds, pendingAt, clearedIds: [...new Set(clearedIds)].slice(-1000), seenIds: Array.isArray(value.seenIds) ? value.seenIds.filter(Number.isSafeInteger).slice(-1000) : [] };
}

async function recordIncomingMessage(userId, messageId, kv, edited = false) {
  if (!Number.isSafeInteger(messageId)) return;
  const key = `inbox_${userId}`, inbox = parseInbox(await kv.get(key), await getAwaitingDays(kv));
  if (!edited && inbox.seenIds.includes(messageId)) return;
  // 手动移除或过期的消息不因编辑重新进入列表；普通回复后的修改仍沿用原来的待回复行为。
  if (edited && inbox.clearedIds.includes(messageId)) return;
  inbox.pendingAt[messageId] ||= Date.now();
  inbox.pendingIds = [...new Set([...inbox.pendingIds, messageId])].slice(-1000);
  inbox.pendingAt = Object.fromEntries(inbox.pendingIds.map((id) => [id, inbox.pendingAt[id]]));
  inbox.seenIds = [...new Set([...inbox.seenIds, messageId])].slice(-1000);
  inbox.incomingAt = Date.now();
  await kv.put(key, JSON.stringify(inbox), { expirationTtl: RECENT_USER_TTL });
}

async function clearAwaitingReply(userId, kv, ids = null) {
  const key = `inbox_${userId}`, raw = await kv.get(key);
  if (!raw) return;
  const inbox = parseInbox(raw);
  const replied = Array.isArray(ids) ? new Set(ids) : null;
  inbox.pendingIds = replied ? inbox.pendingIds.filter((id) => !replied.has(id)) : [];
  inbox.pendingAt = Object.fromEntries(inbox.pendingIds.map((id) => [id, inbox.pendingAt[id]])); inbox.outgoingAt = Date.now();
  await kv.put(key, JSON.stringify(inbox), { expirationTtl: RECENT_USER_TTL });
}

async function awaitingContacts(kv, adminId) {
  const days = await getAwaitingDays(kv);
  const keys = await listAllKeys(kv, "inbox_");
  const ids = keys.map((key) => key.name.slice(6)).filter((id) => /^\d{1,20}$/.test(id) && id !== String(adminId));
  const values = await readMany(kv, ids.flatMap((id) => [`inbox_${id}`, `recent_${id}`, `profile_${id}`, `note_${id}`, `lock_${id}`]));
  return ids.map((id) => {
    const inbox = parseInbox(values.get(`inbox_${id}`), days), user = parseRecentUser(values.get(`recent_${id}`)) || parseObject(values.get(`profile_${id}`)), note = parseContactNote(values.get(`note_${id}`));
    return { id, count: inbox.pendingIds.length, updatedAt: normalizeTimestamp(inbox.incomingAt), name: user?.firstName || user?.username || note?.firstName || `访客${id}`, username: user ? user.username || "" : note?.username || "", note: note?.text || "", locked: Number(values.get(`lock_${id}`)) > Date.now() };
  }).filter((user) => user.count && !user.locked).sort((a, b) => b.updatedAt - a.updatedAt);
}

async function buildAwaitingList(kv, adminId, requestedPage = 0) {
  const users = await awaitingContacts(kv, adminId), page = getListPage(users, requestedPage);
  const days = await getAwaitingDays(kv);
  const lines = page.items.map((user) => `${formatContactNameHtml(truncateText(user.name, 20), user.username, user.id)}｜${user.count}${user.count === 1000 ? "+" : ""} 条待回复\n🆔 <code>${escapeHtml(user.id)}</code>${user.note ? `\n📝 ${escapeHtml(user.note)}` : ""}`);
  const replyMarkup = getVisitorListButtons(page.items, "awaiting", page);
  // “清除当前会话”只退出聊天，不能用来清除待回复。
  replyMarkup.inline_keyboard.splice(-2, 1, [
    { text: "🗑️ 清理待回复", callback_data: `awaiting_manage:${page.page}` },
    { text: `⏱️ 自动清理：${days ? `${days}天` : "关闭"}`, callback_data: "awaiting_settings" },
  ]);
  const statuses = await loadUserStatuses(kv, page.items.map((user) => user.id));
  return compactContactList({ text: `📬 待回复（${users.length} 人）\n━━━━━━━━━━━━━━\n${lines.join("\n\n") || "当前没有待回复的消息"}`, replyMarkup }, "awaiting", page,
    page.items.map((user) => ({ ...user, ...statuses.get(user.id) })), `📬 待回复（${users.length} 人）`, "当前没有待回复的消息");
}

async function sweepAwaiting(kv) {
  const days = await getAwaitingDays(kv);
  if (!days) return;
  const keys = await listAllKeys(kv, "inbox_");
  for (const key of keys) {
    const raw = await kv.get(key.name), before = parseInbox(raw), after = parseInbox(raw, days);
    if (before.pendingIds.length !== after.pendingIds.length || after.pendingIds.some((id) => !normalizeTimestamp(parseObject(raw)?.pendingAt?.[id]))) await kv.put(key.name, JSON.stringify(after), { expirationTtl: RECENT_USER_TTL });
  }
}

async function clearPendingIds(userId, ids, kv) {
  const key = `inbox_${userId}`, raw = await kv.get(key);
  if (!raw) return 0;
  const inbox = parseInbox(raw), cleared = new Set(ids), before = inbox.pendingIds.length;
  inbox.clearedIds = [...new Set([...inbox.clearedIds, ...inbox.pendingIds.filter((id) => cleared.has(id))])].slice(-1000);
  inbox.pendingIds = inbox.pendingIds.filter((id) => !cleared.has(id));
  inbox.pendingAt = Object.fromEntries(inbox.pendingIds.map((id) => [id, inbox.pendingAt[id]]));
  if (before !== inbox.pendingIds.length) await kv.put(key, JSON.stringify(inbox), { expirationTtl: RECENT_USER_TTL });
  return before - inbox.pendingIds.length;
}

async function showAwaitingManagement(env, config, messageId, requestedPage = 0) {
  const kv = env.BOT_KV, page = getListPage(await awaitingContacts(kv, config.adminId), requestedPage), rows = [], nonce = makeNonce(), snapshot = [];
  for (const user of page.items) snapshot.push({ id: user.id, ids: parseInbox(await kv.get(`inbox_${user.id}`)).pendingIds });
  for (let i = 0; i < page.items.length; i += 2) rows.push(page.items.slice(i, i + 2).map((user) => ({
    text: `清除 ${shortBlacklistName(user.name, 10)}`, callback_data: `awaiting_clear:${user.id}:${page.page}:${nonce}`,
  })));
  const nav = [];
  if (page.page > 0) nav.push({ text: "⬅️ 上一页", callback_data: `awaiting_manage:${page.page - 1}` });
  nav.push({ text: `${page.page + 1} / ${page.pageCount}`, callback_data: "list_page_info" });
  if (page.page + 1 < page.pageCount) nav.push({ text: "下一页 ➡️", callback_data: `awaiting_manage:${page.page + 1}` });
  rows.push(nav);
  if (page.items.length) rows.push([{ text: "清除全部待回复", callback_data: "awaiting_clear_all" }]);
  rows.push([{ text: "⬅️ 返回待回复", callback_data: `awaiting_page:${page.page}` }]);
  const rendered = await renderAdminView(`🗑️ 清理待回复\n${page.items.length ? "选择要清除的联系人" : "当前没有待回复的消息"}`, { inline_keyboard: rows }, env, config, messageId);
  if (rendered?.ok) {
    await kv.put(`admin_awaiting_clear_page_${nonce}`, JSON.stringify({ owner: config.adminId, messageId: rendered.result.message_id, expiresAt: Date.now() + 600000, snapshot }), { expirationTtl: 600 });
    await kv.put(`admin_awaiting_clear_page_current_${config.adminId}`, nonce, { expirationTtl: 600 });
  }
}

async function showAwaitingSettings(env, config, messageId) {
  const days = await getAwaitingDays(env.BOT_KV);
  const choices = [0, 3, 5, 7].map((value) => ({ text: `${days === value ? "✓ " : ""}${value ? `${value}天` : "关闭"}`, callback_data: `awaiting_set:${value}` }));
  await renderAdminView(`⏱️ 待回复自动清理\n当前：${days ? `${days}天` : "关闭"}\n按每条消息的等待时间清理，聊天记录保留`, {
    inline_keyboard: [choices.slice(0, 2), choices.slice(2), [{ text: "⬅️ 返回待回复", callback_data: "awaiting" }]],
  }, env, config, messageId);
}

function relayMedia(msg) {
  if (Array.isArray(msg.photo) && msg.photo.length) {
    const photo = msg.photo[msg.photo.length - 1];
    if (typeof photo.file_id === "string") return { type: "photo", media: photo.file_id, key: `photo:${photo.file_unique_id || photo.file_id}` };
  }
  for (const type of ["video", "animation", "audio", "document"]) {
    const media = msg[type];
    if (typeof media?.file_id === "string") return { type, media: media.file_id, key: `${type}:${media.file_unique_id || media.file_id}` };
  }
  return null;
}
function editedMediaFields(msg) {
  const fields = {};
  if (Array.isArray(msg.photo)) fields.photo = msg.photo.map((photo) => ({ file_id: photo.file_id, file_unique_id: photo.file_unique_id }));
  for (const type of ["video", "animation", "audio", "document"]) if (msg[type]) fields[type] = { file_id: msg[type].file_id, file_unique_id: msg[type].file_unique_id };
  if (typeof msg.has_media_spoiler === "boolean") fields.has_media_spoiler = msg.has_media_spoiler;
  return fields;
}
async function contentFingerprint(msg) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ text: msg.text ?? null, caption: msg.caption ?? null, entities: msg.entities || [], captionEntities: msg.caption_entities || [], mediaKey: relayMedia(msg)?.key || null, spoiler: msg.has_media_spoiler === true })));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function recordMessageOrigin(msg, targetId, relayedId, kind, env, delivery = {}) {
  const sourceId = String(msg.chat?.id || (kind === "visitor" ? "" : env.MY_ADMIN_ID || ""));
  if (!sourceId || !Number.isSafeInteger(msg.message_id)) return;
  await env.BOT_KV.put(`origin_${sourceId}_${msg.message_id}`, JSON.stringify({ targetId: String(targetId), relayedId: Number.isSafeInteger(relayedId) ? relayedId : null, kind, bodyType: relayBodyType(msg), mediaKey: relayMedia(msg)?.key || null, mediaSpoiler: msg.has_media_spoiler === true, showCaptionAboveMedia: msg.show_caption_above_media, ...delivery, hash: await contentFingerprint(msg), editDate: Number(msg.edit_date) || 0, updateId: 0 }), { expirationTtl: MSG_MAP_TTL });
}

function relayBodyType(msg) {
  if (msg.media_group_id || ["photo", "video", "animation", "audio", "document", "voice", "live_photo"].some((key) => msg[key]) || typeof msg.caption === "string") return "caption";
  return typeof msg.text === "string" ? "text" : null;
}
function canCopyRelayMessage(msg) {
  return !msg.invoice && !msg.paid_media && !msg.giveaway && !msg.giveaway_winners &&
    !(msg.poll?.type === "quiz" && !Number.isInteger(msg.poll.correct_option_id) && !Array.isArray(msg.poll.correct_option_ids));
}
function hasForwardOrigin(msg) {
  return !!(msg.forward_origin || msg.forward_from || msg.forward_from_chat || msg.forward_sender_name || msg.forward_date);
}
function relaySourceUrl(msg) {
  const origin = msg.forward_origin;
  const chat = origin?.chat || msg.forward_from_chat;
  const id = origin?.message_id || msg.forward_from_message_id;
  if (chat && Number.isSafeInteger(id) && id > 0) {
    if (/^[A-Za-z0-9_]{1,64}$/.test(chat.username || "")) return `https://t.me/${chat.username}/${id}`;
    if (/^-100\d+$/.test(String(chat.id || ""))) return `https://t.me/c/${String(chat.id).slice(4)}/${id}`;
  }
  const bot = origin?.sender_user || msg.forward_from;
  return bot?.is_bot && /^[A-Za-z0-9_]{1,64}$/.test(bot.username || "") ? `https://t.me/${bot.username}` : null;
}
function preservedRelayButtons(msg) {
  const sourceUrl = relaySourceUrl(msg);
  const rows = msg.reply_markup?.inline_keyboard || [];
  return { inline_keyboard: rows.filter(Array.isArray).map((row) => row.map((button) => {
    const text = truncateText(toSafeUnicode(button.text || "原消息按钮"), 64);
    const style = ["danger", "success", "primary"].includes(button.style) ? { style: button.style } : {};
    if (/^(https?:\/\/|tg:\/\/)/i.test(button.url || "")) return { text, url: button.url, ...style };
    if (typeof button.copy_text?.text === "string" && Array.from(button.copy_text.text).length >= 1 && Array.from(button.copy_text.text).length <= 256) return { text, copy_text: { text: button.copy_text.text }, ...style };
    const url = button.login_url?.url || button.web_app?.url;
    if (/^https?:\/\//i.test(url || "")) return { text, url, ...style };
    // 不把其他机器人的 callback_data / pay / inline 操作冒充为本机器人操作。
    return sourceUrl ? { text, url: sourceUrl, ...style } : { text, callback_data: "relay_source_button", ...style };
  })).filter((row) => row.length) };
}
function nativeForwardButtons(msg, forwarded = {}) {
  // 只保留可直接复用的原按钮；外部机器人的回调、支付、登录与小程序不能换成我们的操作。
  const markup = forwarded.reply_markup ?? msg.reply_markup ?? { inline_keyboard: [] };
  if (!Array.isArray(markup.inline_keyboard)) return null;
  for (const row of markup.inline_keyboard) {
    if (!Array.isArray(row)) return null;
    for (const button of row) {
      if (!button || typeof button !== "object" || typeof button.text !== "string") return null;
      const allowed = ["text", "url", "copy_text", "style", "icon_custom_emoji_id", "disabled"];
      if (Object.keys(button).some((key) => !allowed.includes(key))) return null;
      if (button.url && (/^tg:\/\/user\?/i.test(button.url) || !/^(https?:\/\/|tg:\/\/)/i.test(button.url))) return null;
      if (!button.url && typeof button.copy_text?.text !== "string" && !button.disabled) return null;
    }
  }
  return JSON.parse(JSON.stringify(markup));
}
function visitorRelayButtons(userId, name, original = { inline_keyboard: [] }) {
  return { inline_keyboard: [...(original?.inline_keyboard || []), [{ text: `💬 ${shortBlacklistName(name || "访客")}`, callback_data: `nfocus:${userId}` }]] };
}
function relayHistoryPointerKey(config, messageId) {
  return `ui_relay_history_pointer_${config.adminId}_${messageId}`;
}
async function withVisitorRelayHistory(env, config, task) {
  const execute = async () => {
    const kv = env.BOT_KV, key = `ui_relay_history_${config.adminId}`, raw = await kv.get(key);
    const events = parseArray(raw);
    if (raw === null) {
      const previous = parseObject(await kv.get(`ui_relay_group_${config.adminId}`));
      // 只接续仍然有效的上一组；不猜测升级前已经丢失的分隔信息。
      if (previous?.userId && Number.isSafeInteger(previous.messageId)) {
        events.push({ userId: previous.userId, messageId: previous.messageId });
        await kv.put(relayHistoryPointerKey(config, previous.messageId), JSON.stringify(previous), { expirationTtl: MSG_MAP_TTL });
      }
    }
    const result = await task(events);
    await kv.put(key, JSON.stringify(events.slice(-256)), { expirationTtl: MSG_MAP_TTL });
    const last = events.at(-1), pointer = last && !last.barrier && await kv.get(relayHistoryPointerKey(config, last.messageId));
    if (pointer) await kv.put(`ui_relay_group_${config.adminId}`, pointer, { expirationTtl: MSG_MAP_TTL });
    else await kv.delete(`ui_relay_group_${config.adminId}`);
    return result;
  };
  return config.runtime ? config.runtime.runUiExclusive(`relay_history_${config.adminId}`, execute) : execute();
}
async function interruptVisitorRelayGroup(env, config, messageId = null) {
  await withVisitorRelayHistory(env, config, async (events) => {
    const id = Number.isSafeInteger(messageId) && messageId > 0 ? messageId : null;
    if (id && events.some((event) => event.barrier && event.messageId === id)) return;
    if (!id && events.at(-1)?.barrier && events.at(-1).messageId === null) return;
    events.push({ barrier: true, messageId: id });
  });
}
async function removeVisitorRelayIdentity(previous, env, config) {
  try {
    const originKey = `origin_${previous.userId}_${previous.sourceId}`, oldOrigin = parseObject(await env.BOT_KV.get(originKey));
    const oldCard = previous.kind === "quote" || (!previous.kind && oldOrigin && ![oldOrigin.relayedId, oldOrigin.correctionId].includes(previous.messageId));
    const result = await safeJson(await callApi(oldCard ? "deleteMessage" : "editMessageReplyMarkup", { chat_id: config.adminId, message_id: previous.messageId,
      ...(!oldCard ? { reply_markup: previous.baseMarkup || { inline_keyboard: [] } } : {}) }, { ...config, apiTimeoutMs: 1500 }));
    const removed = result.ok || /message is not modified|message to (?:edit|delete) not found/i.test(result.description || "");
    if (!removed) { console.warn("旧联系人按钮清理失败:", result.description); return false; }
    if (oldCard) await env.BOT_KV.delete(`msg_${previous.messageId}`);
    if (oldOrigin) await env.BOT_KV.put(originKey, JSON.stringify({ ...oldOrigin, relayContact: false, replyMarkup: oldCard && oldOrigin.transport === "forward" ? null : previous.baseMarkup || { inline_keyboard: [] } }), { expirationTtl: MSG_MAP_TTL });
    return true;
  } catch (error) { console.warn("旧联系人按钮清理失败:", redactSensitiveInfo(error?.message || error, env)); return false; }
}
async function mergeVisitorRelayHistory(events, env, config) {
  let attempts = 0;
  for (let i = 0; i + 1 < events.length && attempts < 4;) {
    const previous = events[i], next = events[i + 1];
    if (previous.barrier || next.barrier || previous.userId !== next.userId) { i++; continue; }
    const pointer = parseObject(await env.BOT_KV.get(relayHistoryPointerKey(config, previous.messageId)));
    if (!pointer || pointer.userId !== next.userId) { i++; continue; }
    attempts++;
    if (await removeVisitorRelayIdentity(pointer, env, config)) {
      events.splice(i, 1);
      await env.BOT_KV.delete(relayHistoryPointerKey(config, previous.messageId));
    } else i++;
  }
}
async function removeVisitorRelaySeparators(messageIds, env, config) {
  if (!messageIds.length) return;
  const removed = new Set(messageIds);
  await withVisitorRelayHistory(env, config, async (events) => {
    for (let i = events.length - 1; i >= 0; i--) if (events[i].barrier && removed.has(events[i].messageId)) events.splice(i, 1);
    await mergeVisitorRelayHistory(events, env, config);
  });
}
async function retainVisitorRelayButton(userId, sourceId, messageId, name, baseMarkup, env, config, alreadyAttached = false, kind = "inline", replyToId = null) {
  return withVisitorRelayHistory(env, config, async (events) => {
    if (!alreadyAttached) {
      try {
        const result = await safeJson(await callApi("editMessageReplyMarkup", { chat_id: config.adminId, message_id: messageId, reply_markup: visitorRelayButtons(userId, name, baseMarkup) }, { ...config, apiTimeoutMs: 1500 }));
        if (!result.ok && !/message is not modified/i.test(result.description || "")) { console.warn("联系人按钮更新失败:", result.description); return false; }
      } catch (error) { console.warn("联系人按钮更新失败:", redactSensitiveInfo(error?.message || error, env)); return false; }
    }
    const pointer = JSON.stringify({ userId, messageId, sourceId, baseMarkup, kind, replyToId, updatedAt: Date.now() });
    await env.BOT_KV.put(`ui_relay_contact_${config.adminId}_${userId}`, pointer, { expirationTtl: MSG_MAP_TTL });
    await env.BOT_KV.put(relayHistoryPointerKey(config, messageId), pointer, { expirationTtl: MSG_MAP_TTL });
    if (!events.some((event) => !event.barrier && event.messageId === messageId)) events.push({ userId, messageId });
    await mergeVisitorRelayHistory(events, env, config);
    return true;
  });
}
async function sendRelayAttribution(userId, sourceId, messageId, name, env, config) {
  // 只显示引用与昵称按钮：Telegram 要求非空 text，用不可见占位避免额外“转发人”正文。
  const extra = { reply_parameters: { message_id: messageId, allow_sending_without_reply: true }, reply_markup: visitorRelayButtons(userId, name) };
  try {
    let result = await sendHtmlMessage(config.adminId, "\u2063", config, extra, { preserveRelayGroup: true });
    // 仅在明确拒绝空白占位时回退一枚气泡，不因网络结果未知再发一张卡片。
    if (!result.ok && result.error_code === 400 && /(?:text|message) (?:is |must be )?empty|message text is empty/i.test(result.description || "")) result = await sendHtmlMessage(config.adminId, "💬", config, extra, { preserveRelayGroup: true });
    if (result.ok && result.result?.message_id) {
      await env.BOT_KV.put(`msg_${result.result.message_id}`, userId, { expirationTtl: MSG_MAP_TTL });
      await retainVisitorRelayButton(userId, sourceId, result.result.message_id, name, { inline_keyboard: [] }, env, config, true, "quote", messageId);
    }
    return result;
  } catch (error) { console.warn("引用卡片发送失败:", redactSensitiveInfo(error?.message || error, env)); return { ok: false }; }
}
function relayEditBody(msg, origin, type) {
  let text = type === "caption" ? msg.caption ?? "" : msg.text;
  if (typeof text !== "string") return null;
  let start = 0;
  if (origin.kind === "push") {
    const match = text.match(/^\/send(?:@[A-Za-z0-9_]+)?\s+([1-9]\d{0,19})\s+([\s\S]+)$/i);
    if (!match || match[1] !== origin.targetId) return null;
    start = match[0].length - match[2].length; text = match[2];
  }
  text = toSafeUnicode(text);
  const original = type === "caption" ? msg.caption_entities : msg.entities;
  const entities = (Array.isArray(original) ? original : []).filter((entity) => Number.isSafeInteger(entity.offset) && Number.isSafeInteger(entity.length) && entity.length > 0 && entity.offset >= start && entity.offset + entity.length <= start + text.length)
    .map((entity) => ({ ...entity, offset: entity.offset - start }));
  // 原位编辑由 Telegram 记录 edit_date；正文与图片说明不添加手工标记。
  return { text, entities };
}
function editedSource(msg) {
  return { message_id: msg.message_id, chat: { id: msg.chat.id, type: "private" }, from: { first_name: msg.from?.first_name || "" }, edit_date: Number(msg.edit_date) || 0,
    ...editedMediaFields(msg), ...(msg.forward_origin ? { forward_origin: msg.forward_origin } : {}), ...(msg.forward_from ? { forward_from: msg.forward_from } : {}),
    ...(msg.forward_from_chat ? { forward_from_chat: msg.forward_from_chat, forward_from_message_id: msg.forward_from_message_id } : {}),
    ...(msg.forward_sender_name ? { forward_sender_name: msg.forward_sender_name } : {}), ...(msg.forward_date ? { forward_date: msg.forward_date } : {}),
    ...(msg.reply_markup ? { reply_markup: msg.reply_markup } : {}), ...(msg.media_group_id ? { media_group_id: msg.media_group_id } : {}), ...(typeof msg.text === "string" ? { text: msg.text, entities: msg.entities || [] } : {}),
    ...(typeof msg.caption === "string" ? { caption: msg.caption, caption_entities: msg.caption_entities || [] } : {}) };
}
async function handleEditedMessage(msg, updateId, env, config, queuedAttempts = null) {
  if (msg.chat?.type !== "private" || !Number.isSafeInteger(msg.message_id)) return;
  const userId = String(msg.chat.id), key = `origin_${userId}_${msg.message_id}`, retryKey = `e:${userId}:${msg.message_id}`;
  const finishRetry = async () => { if (config.runtime) await config.runtime.ctx.storage.delete(retryKey); };
  let origin = parseObject(await env.BOT_KV.get(key));
  if (userId !== config.adminId && ((await env.BOT_KV.get(`auth_${userId}`)) !== "true" || Number(await env.BOT_KV.get(`lock_${userId}`)) > Date.now())) { await finishRetry(); return; }
  if (userId === config.adminId && origin && await isOutboundBlocked(origin.targetId, env, config)) { await finishRetry(); return; }
  if (!origin) {
    await finishRetry();
    if (msg.media_group_id && config.runtime) await config.runtime.updateQueuedAlbumContent(msg);
    return;
  }
  const hash = await contentFingerprint(msg), editDate = Number(msg.edit_date) || 0;
  const older = editDate < origin.editDate || (editDate === origin.editDate && origin.updateId && Number.isSafeInteger(updateId) && updateId <= origin.updateId);
  const retryJob = hash === origin.hash && config.runtime ? await config.runtime.ctx.storage.get(retryKey) : null;
  // 网络错误可能发生在 Telegram 已执行编辑之后；改回原文也必须实际确认一次。
  const mustConfirm = retryJob?.uncertain && !older;
  if ((hash === origin.hash && !mustConfirm) || older) {
    if (hash === origin.hash && !older) {
      // 用户在限流期间改回已送达的内容：取消更早的待重试，推进版本防止旧编辑覆盖。
      await env.BOT_KV.put(key, JSON.stringify({ ...origin, editDate, updateId: Number.isSafeInteger(updateId) ? updateId : 0 }), { expirationTtl: MSG_MAP_TTL });
      if (config.runtime) {
        const waiting = await config.runtime.ctx.storage.get(retryKey);
        if (waiting && (editDate > waiting.message.edit_date || (editDate === waiting.message.edit_date && Number(updateId) >= waiting.updateId))) await finishRetry();
      }
    }
    if (queuedAttempts !== null) await finishRetry();
    return;
  }
  const sourceType = origin.bodyType || relayBodyType(msg), type = origin.correctionId ? origin.correctionBodyType || "text" : sourceType;
  const incomingMedia = relayMedia(msg), mediaChanged = !!incomingMedia && (incomingMedia.key !== origin.mediaKey || (msg.has_media_spoiler === true) !== (origin.mediaSpoiler === true));
  const replaceMedia = mediaChanged && (type === "caption" || !origin.correctionId);
  const editMsg = origin.correctionId && type === "text" && sourceType === "caption" ? { ...msg, text: msg.caption || "", entities: msg.caption_entities } : msg;
  let body = relayEditBody(editMsg, origin, type);
  if (!body) { if (queuedAttempts !== null) await finishRetry(); return; }
  if (type === "text" && sourceType === "caption" && body.text === "") body = { text: "（图片说明已清除）", entities: [] };
  if (config.runtime && queuedAttempts === null) {
    const waiting = await config.runtime.ctx.storage.get(retryKey);
    if (waiting) { await config.runtime.queueMessageEdit(msg, updateId, Math.max(1, waiting.dueAt - Date.now()), waiting.attempts); return; }
  }
  const targetMessageId = origin.correctionId || origin.relayedId;
  if (!Number.isSafeInteger(targetMessageId) || targetMessageId <= 0) { await finishRetry(); return; }
  const attempts = queuedAttempts || 0;
  const deferred = async (delay, uncertain = false) => {
    if (!config.runtime || attempts >= 3) return false;
    await config.runtime.queueMessageEdit(msg, updateId, delay, attempts + 1, uncertain); return true;
  };
  let result;
  try {
    const field = type === "caption" ? "caption" : "text";
    const captionBody = replaceMedia ? relayEditBody(msg, origin, "caption") : body;
    const media = replaceMedia ? { type: incomingMedia.type, media: incomingMedia.media, caption: captionBody.text, caption_entities: captionBody.entities,
      ...(["photo", "video", "animation"].includes(incomingMedia.type) ? { has_spoiler: msg.has_media_spoiler === true, ...(typeof origin.showCaptionAboveMedia === "boolean" ? { show_caption_above_media: origin.showCaptionAboveMedia } : {}) } : {}) } : null;
    result = await safeJson(await callApi(replaceMedia ? "editMessageMedia" : type === "caption" ? "editMessageCaption" : "editMessageText", { chat_id: origin.targetId, message_id: targetMessageId,
      ...(replaceMedia ? { media } : { [field]: body.text, [type === "caption" ? "caption_entities" : "entities"]: body.entities,
        ...(type === "text" ? { link_preview_options: { is_disabled: true } } : {}), ...(type === "caption" && typeof origin.showCaptionAboveMedia === "boolean" ? { show_caption_above_media: origin.showCaptionAboveMedia } : {}) }),
      ...(origin.replyMarkup ? { reply_markup: origin.replyMarkup } : {}) }, { ...config, apiTimeoutMs: 4000 }));
  } catch (error) {
    // 编辑已知 ID 可安全重试；不创建第二条消息。
    if (await deferred(2000, true)) return;
    await finishRetry(); await safeNotifyAdmin(env, config, "⚠️ 消息修改同步未确认，请检查对应聊天记录"); return;
  }
  if (!result.ok && /message is not modified/i.test(result.description || "")) result = { ok: true };
  if (!result.ok && result.error_code === 429) {
    const seconds = Number(result.parameters?.retry_after);
    if (await deferred(Math.min(3600, Number.isFinite(seconds) && seconds > 0 ? seconds : 2) * 1000)) return;
  }
  if (!result.ok && result.error_code === 400 && /message (?:to edit not found|can't be edited|cannot be edited)/i.test(result.description || "")) {
    if (origin.correctionId || origin.correctionUncertain || origin.correctionStarted) {
      await finishRetry(); await safeNotifyAdmin(env, config, "⚠️ 原消息或修订消息无法编辑，请检查对应聊天记录"); return;
    }
    // 旧版转发或已删除副本：只创建一条修订副本，以后的修改仍在这条副本上更新。
    const current = origin.kind === "visitor" && parseObject(await env.BOT_KV.get(`ui_relay_contact_${config.adminId}_${userId}`));
    const keepContact = origin.kind === "visitor" && (origin.relayContact === true || (origin.relayContact == null && (!current || current.messageId === origin.relayedId)));
    const replyMarkup = origin.kind === "visitor" ? keepContact ? visitorRelayButtons(userId, msg.from?.first_name, origin.baseReplyMarkup) : origin.baseReplyMarkup || { inline_keyboard: [] } : origin.replyMarkup;
    origin = { ...origin, correctionStarted: true, replyMarkup, relayContact: keepContact };
    await env.BOT_KV.put(key, JSON.stringify(origin), { expirationTtl: MSG_MAP_TTL });
    if (!replaceMedia && (origin.bodyType || relayBodyType(msg)) === "caption") body = relayEditBody({ ...msg, text: msg.caption || "", entities: msg.caption_entities }, { ...origin, kind: origin.kind === "push" ? "admin" : origin.kind }, "text");
    if (!replaceMedia && body.text === "") body = { text: "（图片说明已清除）", entities: [] };
    const correctionMedia = replaceMedia ? relayEditBody(msg, origin, "caption") : null;
    try {
      const mediaMethods = { photo: "sendPhoto", video: "sendVideo", animation: "sendAnimation", audio: "sendAudio", document: "sendDocument" };
      result = await safeJson(await callApi(replaceMedia ? mediaMethods[incomingMedia.type] : "sendMessage", { chat_id: origin.targetId,
        ...(replaceMedia ? { [incomingMedia.type]: incomingMedia.media, caption: correctionMedia.text, caption_entities: correctionMedia.entities } : { text: body.text, entities: body.entities, link_preview_options: { is_disabled: true } }),
        reply_parameters: { message_id: origin.relayedId, allow_sending_without_reply: true }, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) }, config));
    } catch (error) {
      await env.BOT_KV.put(key, JSON.stringify({ ...origin, correctionUncertain: true }), { expirationTtl: MSG_MAP_TTL });
      await finishRetry(); await safeNotifyAdmin(env, config, "⚠️ 修订副本发送结果未确认，请检查聊天记录；系统不会自动重复创建"); return;
    }
    if (result.ok && Number.isSafeInteger(result.result?.message_id)) {
      origin = { ...origin, correctionId: result.result.message_id, correctionBodyType: replaceMedia ? "caption" : "text", correctionStarted: false };
      if (keepContact) await retainVisitorRelayButton(userId, msg.message_id, result.result.message_id, msg.from?.first_name, origin.baseReplyMarkup || { inline_keyboard: [] }, env, config, true);
    }
    else {
      await env.BOT_KV.put(key, JSON.stringify({ ...origin, correctionStarted: false }), { expirationTtl: MSG_MAP_TTL });
      result = { ...result, ok: false };
    }
  }
  if (!result.ok) { await finishRetry(); await safeNotifyAdmin(env, config, `❌ 消息修改同步失败\n${formatDeliveryFailure(result.description)}`); return; }
  if (origin.kind === "visitor") {
    await env.BOT_KV.put(`msg_${origin.correctionId || origin.relayedId}`, userId, { expirationTtl: MSG_MAP_TTL });
    await recordIncomingMessage(userId, msg.message_id, env.BOT_KV, true);
    await maybeSendAwayNotice(userId, env, config);
  } else await recordAdminCommunication(origin.targetId, env, config);
  await env.BOT_KV.put(key, JSON.stringify({ ...origin, ...(incomingMedia ? { mediaKey: incomingMedia.key, mediaSpoiler: msg.has_media_spoiler === true, bodyType: "caption" } : {}), hash, editDate, updateId: Number.isSafeInteger(updateId) ? updateId : 0 }), { expirationTtl: MSG_MAP_TTL });
  await finishRetry();
}

async function getAwaySettings(kv, adminId) {
  const value = parseObject(await kv.get(`away_admin_${adminId}`));
  return { enabled: value?.enabled === true, text: typeof value?.text === "string" && value.text.trim() ? truncateText(value.text.trim(), 500) : DEFAULT_AWAY_TEXT };
}

async function maybeSendAwayNotice(userId, env, config) {
  const settings = await getAwaySettings(env.BOT_KV, config.adminId);
  if (!settings.enabled) return;
  const key = `away_notice_${userId}`, now = Date.now(), last = Number(await env.BOT_KV.get(key)) || 0;
  if (last && now - last < 24 * 60 * 60 * 1000) return;
  await env.BOT_KV.put(key, String(now), { expirationTtl: 86400 });
  await runOptionalTask(config, env, "离开模式提示", async () => {
    if (!(await getAwaySettings(env.BOT_KV, config.adminId)).enabled) {
      if ((await env.BOT_KV.get(key)) === String(now)) await env.BOT_KV.delete(key);
      return;
    }
    const result = await sendMessage(userId, settings.text, env, config, {}, { notifyOnFail: false });
    if (!result.ok && (await env.BOT_KV.get(key)) === String(now)) await env.BOT_KV.delete(key);
  });
}

// 新增管理入口：所有输入仅在管理员私聊中处理。
function albumSource(msg) {
  return { ...editedSource(msg), ...(typeof msg.show_caption_above_media === "boolean" ? { show_caption_above_media: msg.show_caption_above_media } : {}) };
}

function makeNonce() { return crypto.randomUUID().replace(/-/g, "").slice(0, 16); }
function charCount(text) { return Array.from(toSafeUnicode(text)).length; }
function getQuickBank(raw) {
  const bank = parseObject(raw);
  if (bank && Array.isArray(bank.items)) return { items: bank.items, nextId: Number(bank.nextId) || 1 };
  return { nextId: 4, items: [
    { id: "1", title: "收到", text: "收到，我看一下。" },
    { id: "2", title: "稍后回复", text: "我现在有点忙，稍后回复你。" },
    { id: "3", title: "补充截图", text: "方便的话，请补充一下截图和具体情况。" },
  ] };
}
async function adminToolTarget(msg, kv, adminId) {
  // 明确回复没有映射时，不回退到另一个当前联系人。
  if (msg.reply_to_message) return await kv.get(`msg_${msg.reply_to_message.message_id}`);
  return (await getActiveAdminTarget(kv, adminId))?.userId || null;
}
async function invalidateQuickPanel(messageId, env, config) {
  if (!messageId) return;
  const key = `quick_menu_${config.adminId}_${messageId}`, nonce = await env.BOT_KV.get(key);
  if (nonce) { await env.BOT_KV.delete(`admin_quick_${nonce}`); await env.BOT_KV.delete(key); }
}
async function renderAdminView(html, buttons, env, config, messageId = null) {
  const pending = parseObject(await env.BOT_KV.get(`admin_input_${config.adminId}`));
  if (pending && pending.originMenuId !== messageId) await clearAdminInput(env, config);
  await retireAdminConfirmations(messageId, env, config);
  if (messageId) await invalidateQuickPanel(messageId, env, config);
  return sendLatestUi(config.adminId, "menu", async () => {
    const result = messageId
      ? await editHtmlMessage(config.adminId, messageId, html, config, { reply_markup: buttons })
      : await sendHtmlMessage(config.adminId, html, config, { reply_markup: buttons });
    return result.ok && !result.result?.message_id && messageId ? { ...result, result: { message_id: messageId } } : result;
  }, env, config, false, messageId);
}
function inputCancelButtons() {
  return { inline_keyboard: [[{ text: "取消输入", callback_data: "input_cancel" }], ...getBackToMenuButtons().inline_keyboard] };
}
async function clearAdminInput(env, config) {
  const key = `admin_input_${config.adminId}`, raw = await env.BOT_KV.get(key), pending = parseObject(raw);
  if (raw === null) return null;
  await env.BOT_KV.delete(key);
  if (Number.isSafeInteger(pending?.messageId)) {
    try { await deleteMessage(config.adminId, pending.messageId, { ...config, apiTimeoutMs: 1500 }); }
    catch (error) { console.warn("管理输入提示清理失败:", redactSensitiveInfo(error?.message || error, env)); }
  }
  return pending;
}

async function retireAdminConfirmations(messageId, env, config) {
  const kv = env.BOT_KV;
  for (const kind of ["", "page_"]) {
    const pointer = `admin_awaiting_clear_${kind}current_${config.adminId}`, nonce = await kv.get(pointer);
    if (nonce) {
      const key = `admin_awaiting_clear_${kind}${nonce}`, context = parseObject(await kv.get(key));
      if (!messageId || !context || context.messageId === messageId) { await kv.delete(key); await kv.delete(pointer); }
    }
  }
  if (config.runtime) {
    for (const [key, preview] of await listNativeRecords(config.runtime.ctx.storage, "r:")) {
      if (preview.owner === config.adminId && (!messageId || preview.messageId === messageId)) await config.runtime.ctx.storage.delete(key);
    }
  }
}

async function resetAdminActions(env, config) {
  await clearAdminInput(env, config);
  if (await env.BOT_KV.get(`admin_restore_input_${config.adminId}`)) await env.BOT_KV.delete(`admin_restore_input_${config.adminId}`);
  await retireAdminConfirmations(null, env, config);
}
async function cancelAdminInput(env, config, messageId = null) {
  const pending = await clearAdminInput(env, config), origin = messageId || pending?.originMenuId;
  if (origin) {
    if (pending?.kind === "away_text") await showAwaySettings(env, config, origin);
    else if (pending?.kind === "quick_add") await showQuickManagement(env, config, origin);
    else await renderAdminMenu(config.adminId, env, config, origin);
  } else await sendMessage(config.adminId, "已取消", env, config);
}
async function inputNotice(text, env, config, messageId = null) {
  if (messageId) return renderAdminView(escapeHtml(text), inputCancelButtons(), env, config, messageId);
  return sendMessage(config.adminId, text, env, config);
}

async function showQuickReplies(targetId, env, config, messageId = null) {
  if (!targetId) return renderAdminView("请先选择联系人，或回复访客消息发送 /quick", getBackToMenuButtons(), env, config, messageId);
  const bank = getQuickBank(await env.BOT_KV.get(`quick_admin_${config.adminId}`)), nonce = makeNonce();
  await env.BOT_KV.put(`admin_quick_${nonce}`, JSON.stringify({ targetId: String(targetId), used: false }), { expirationTtl: 600 });
  const user = await getRecentUserById(env.BOT_KV, targetId);
  const rows = bank.items.map((item) => [{ text: item.title, callback_data: `qsend:${nonce}:${item.id}` }]);
  rows.push([{ text: "⚙️ 管理模板", callback_data: "quick_manage" }], [{ text: "⬅️ 返回菜单", callback_data: "menu_main" }]);
  const result = await renderAdminView(`⚡ 快捷回复\n${formatContactNameHtml(user?.firstName || `访客${targetId}`, user?.username, targetId)}\n🆔 <code>${escapeHtml(targetId)}</code>`, { inline_keyboard: rows }, env, config, messageId);
  if (result.ok && Number.isSafeInteger(result.result?.message_id)) {
    await env.BOT_KV.put(`admin_quick_${nonce}`, JSON.stringify({ targetId: String(targetId), used: false, menuId: result.result.message_id }), { expirationTtl: 600 });
    await env.BOT_KV.put(`quick_menu_${config.adminId}_${result.result.message_id}`, nonce, { expirationTtl: 600 });
  }
  else await env.BOT_KV.delete(`admin_quick_${nonce}`);
  return result;
}
async function showQuickManagement(env, config, messageId = null) {
  const bank = getQuickBank(await env.BOT_KV.get(`quick_admin_${config.adminId}`));
  const rows = [];
  for (let i = 0; i < bank.items.length; i += 2) rows.push(bank.items.slice(i, i + 2).map((item) => ({ text: `${item.id}. ${item.title}`, callback_data: `quick_view:${item.id}` })));
  rows.push([{ text: "➕ 添加模板", callback_data: "quick_add" }], [{ text: "⬅️ 返回菜单", callback_data: "menu_main" }]);
  return renderAdminView(`⚙️ 回复模板（${bank.items.length}/10）\n${bank.items.map((item) => `${escapeHtml(item.id)}. <b>${escapeHtml(item.title)}</b>\n${escapeHtml(truncateText(item.text, 120))}`).join("\n\n") || "暂无模板"}\n\n删除：/quick del 编号\n发送：/quick 编号`, { inline_keyboard: rows }, env, config, messageId);
}
async function addQuickReply(value, env, config, originMenuId = null) {
  const split = value.indexOf("|"), title = value.slice(0, split).trim(), text = value.slice(split + 1).trim();
  if (split < 1 || !title || !text || charCount(title) > 20 || charCount(text) > 1000) {
    await inputNotice("用法：/quick add 标题 | 内容\n标题最多 20 字，内容最多 1000 字", env, config, originMenuId); return false;
  }
  const key = `quick_admin_${config.adminId}`, bank = getQuickBank(await env.BOT_KV.get(key));
  if (bank.items.length >= 10 || bank.nextId > 999999) { await inputNotice("模板已达上限，请先删除一条", env, config, originMenuId); return false; }
  const item = { id: String(bank.nextId++), title, text }; bank.items.push(item);
  await env.BOT_KV.put(key, JSON.stringify(bank));
  if (!originMenuId) await sendMessage(config.adminId, `已添加模板 ${item.id}：${title}`, env, config); return true;
}
function quickMenuId(context, query, config) {
  if (Number.isSafeInteger(context?.menuId) && context.menuId > 0) return context.menuId;
  return String(query?.message?.chat?.id || "") === config.adminId && Number.isSafeInteger(query.message.message_id) && query.message.message_id > 0 ? query.message.message_id : null;
}
async function clearQuickButtons(menuId, env, config) {
  if (!menuId) return;
  try { await callApi("editMessageReplyMarkup", { chat_id: config.adminId, message_id: menuId, reply_markup: { inline_keyboard: [] } }, { ...config, apiTimeoutMs: 1500 }); }
  catch (error) { console.warn("快捷菜单按钮清理失败:", redactSensitiveInfo(error?.message || error, env)); }
}
async function deliverQuickReply(targetId, item, env, config, menuId = null) {
  let result;
  try { result = await isOutboundBlocked(targetId, env, config) ? blockedDelivery() : await sendMessage(targetId, item.text, env, config, {}, { notifyOnFail: false }); }
  catch (error) { result = { ok: false, uncertain: true, description: redactSensitiveInfo(error?.message || error, env) }; }
  if (result.ok) await recordAdminCommunication(targetId, env, config);
  const user = await getRecentUserById(env.BOT_KV, targetId);
  const status = result.ok ? "✅ 快捷回复已发送" : result.uncertain ? "⚠️ 快捷回复发送结果待确认" : "❌ 快捷回复未送达";
  const record = `${status}\n联系人：${formatContactNameHtml(truncateText(user?.firstName || `访客${targetId}`, 40), user?.username, targetId)}\n🆔 <code>${escapeHtml(targetId)}</code>\n模板：${escapeHtml(item.title)}\n\n${escapeHtml(item.text)}${result.ok ? "" : `\n\n${escapeHtml(formatDeliveryFailure(result.description))}${result.uncertain ? "\n请检查对方聊天记录后决定是否重发" : ""}`}`;
  let logged = false;
  try {
    // 内容已按模板1000字、标题20字、昵称40字限制；避免按HTML转义后的长度截掉正文。
    const sent = await safeJson(await callApi("sendMessage", { chat_id: config.adminId, text: record, parse_mode: "HTML", link_preview_options: { is_disabled: true } }, config));
    logged = sent.ok;
    if (logged) await interruptVisitorRelayGroup(env, config, sent.result?.message_id);
  } catch (error) { console.warn("快捷回复记录发送失败:", redactSensitiveInfo(error?.message || error, env)); }
  if (menuId) {
    if (logged) {
      try { await deleteMessage(config.adminId, menuId, { ...config, apiTimeoutMs: 1500 }); }
      catch (error) { console.warn("快捷菜单删除失败:", redactSensitiveInfo(error?.message || error, env)); }
    } else {
      // 记录消息未发送成功时，将原菜单变成永久记录，按钮已经收起。
      try {
        const saved = await safeJson(await callApi("editMessageText", { chat_id: config.adminId, message_id: menuId, text: record, parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: [] } }, config));
        if (saved.ok) {
          if (parseObject(await env.BOT_KV.get(`ui_menu_${config.adminId}`))?.messageId === menuId) await env.BOT_KV.delete(`ui_menu_${config.adminId}`);
          await invalidateQuickPanel(menuId, env, config);
        } else console.warn("快捷回复记录保存失败:", redactSensitiveInfo(saved.description, env));
      }
      catch (error) { console.warn("快捷回复记录保存失败:", redactSensitiveInfo(error?.message || error, env)); }
    }
  }
  return result;
}
async function showAwaySettings(env, config, messageId = null) {
  const setting = await getAwaySettings(env.BOT_KV, config.adminId);
  return renderAdminView(`🌙 离开模式：${setting.enabled ? "已开启" : "已关闭"}\n\n${escapeHtml(setting.text)}`, { inline_keyboard: [
    [{ text: setting.enabled ? "关闭" : "开启", callback_data: setting.enabled ? "away_off" : "away_on" }, { text: "✏️ 修改提示", callback_data: "away_text" }],
    [{ text: "⬅️ 返回菜单", callback_data: "menu_main" }],
  ] }, env, config, messageId);
}
async function advancedInput(kind, env, config, originMenuId = null) {
  return beginAdminInput(kind, null, env, config, originMenuId);
}

async function setAwayText(text, env, config, originMenuId = null) {
  if (!text || charCount(text) > 500) { await inputNotice("离开提示需要 1–500 字", env, config, originMenuId); return false; }
  const setting = await getAwaySettings(env.BOT_KV, config.adminId);
  await env.BOT_KV.put(`away_admin_${config.adminId}`, JSON.stringify({ ...setting, text }));
  if (!originMenuId) await sendMessage(config.adminId, "离开提示已保存", env, config); return true;
}
async function handleAdvancedAdminTools(msg, text, env, config) {
  const kv = env.BOT_KV, adminId = config.adminId;
  const pending = parseObject(await kv.get(`admin_input_${adminId}`));
  if (pending && msg.reply_to_message?.message_id === pending.messageId && ["quick_add", "away_text"].includes(pending.kind)) {
    if (/^\/cancel(?:@[A-Za-z0-9_]+)?$/i.test(text)) { await cancelAdminInput(env, config); return true; }
    if (!text || text.startsWith("/")) { await inputNotice("请回复文字，或发送 /cancel 取消", env, config, pending.originMenuId); return true; }
    const saved = pending.kind === "quick_add" ? await addQuickReply(text, env, config, pending.originMenuId) : await setAwayText(text, env, config, pending.originMenuId);
    if (saved) {
      await clearAdminInput(env, config);
      if (pending.originMenuId) {
        if (pending.kind === "quick_add") await showQuickManagement(env, config, pending.originMenuId);
        else await showAwaySettings(env, config, pending.originMenuId);
      }
    }
    return true;
  }
  if (!text.startsWith("/") && msg.reply_to_message && pending?.messageId !== msg.reply_to_message.message_id && await kv.get(`admin_prompt_${adminId}_${msg.reply_to_message.message_id}`)) {
    await inputNotice("这个管理输入已结束，请重新打开输入页面", env, config, pending?.originMenuId); return true;
  }
  const restoreArmed = await kv.get(`admin_restore_input_${adminId}`);
  const document = msg.document || (text.match(/^\/restore(?:@[A-Za-z0-9_]+)?$/i) ? msg.reply_to_message?.document : null);
  const restoreCaption = /^\/restore(?:@[A-Za-z0-9_]+)?$/.test(msg.caption || "");
  if (document && (restoreArmed || restoreCaption || /^chuanhuatong-backup-.*\.json$/i.test(document.file_name || "") || /^\/restore/.test(text))) {
    const origin = parseObject(restoreArmed)?.messageId;
    try {
      const snapshot = await readBackupDocument(document, env, config);
      await config.runtime.stageRestore(snapshot, config, origin);
      await kv.delete(`admin_restore_input_${adminId}`);
    } catch (error) {
      await renderAdminView(escapeHtml(`❌ 未导入：${truncateText(redactSensitiveInfo(error?.message || error, env), 300)}\n请重新发送备份 JSON 文件`), { inline_keyboard: [[{ text: "取消导入", callback_data: "backup_import_cancel" }], ...getBackToMenuButtons().inline_keyboard] }, env, config, origin);
    }
    return true;
  }
  const match = text.match(/^\/(inbox|done|quick|away|backup|restore)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/i);
  if (!match) {
    if (/^\/cancel(?:@[A-Za-z0-9_]+)?$/i.test(text) && restoreArmed) { await kv.delete(`admin_restore_input_${adminId}`); await config.runtime.showBackups(config, parseObject(restoreArmed)?.messageId, "已取消备份导入"); return true; }
    return false;
  }
  const action = match[1].toLowerCase(), args = (match[2] || "").trim();
  if (action === "inbox") { const view = await buildAwaitingList(kv, adminId); await renderContactList(view, env, config); }
  if (action === "done") {
    const targetId = /^\d{1,20}$/.test(args) ? args : !args ? await adminToolTarget(msg, kv, adminId) : null;
    if (!targetId) await sendMessage(adminId, "用法：/done ID，或回复访客消息发送 /done", env, config);
    else { await clearPendingIds(targetId, parseInbox(await kv.get(`inbox_${targetId}`)).pendingIds, kv); await sendHtmlMessage(adminId, `✅ 已标记处理\n🆔 <code>${escapeHtml(targetId)}</code>`, config); }
  }
  if (action === "quick") {
    if (args === "list") await showQuickManagement(env, config);
    else if (args.startsWith("add ")) await addQuickReply(args.slice(4).trim(), env, config);
    else if (/^del \d{1,6}$/.test(args)) {
      const key = `quick_admin_${adminId}`, bank = getQuickBank(await kv.get(key)), id = args.slice(4), oldLength = bank.items.length;
      bank.items = bank.items.filter((item) => item.id !== id);
      if (oldLength === bank.items.length) await sendMessage(adminId, "模板编号不存在", env, config);
      else { await kv.put(key, JSON.stringify(bank)); await sendMessage(adminId, `已删除模板 ${id}`, env, config); }
    } else {
      const target = await adminToolTarget(msg, kv, adminId);
      if (!args) await showQuickReplies(target, env, config);
      else {
        const item = getQuickBank(await kv.get(`quick_admin_${adminId}`)).items.find((item) => item.id === args);
        if (!target || !item) await sendMessage(adminId, "请先选择联系人，并使用 /quick list 查看模板编号", env, config);
        else await deliverQuickReply(target, item, env, config);
      }
    }
  }
  if (action === "away") {
    if (args === "on" || args === "off") { const setting = await getAwaySettings(kv, adminId); await kv.put(`away_admin_${adminId}`, JSON.stringify({ ...setting, enabled: args === "on" })); }
    else if (args.startsWith("text ")) { await setAwayText(args.slice(5).trim(), env, config); return true; }
    else if (args) { await sendMessage(adminId, "用法：/away on、/away off 或 /away text 提示内容", env, config); return true; }
    await showAwaySettings(env, config);
  }
  if (action === "backup") { const snapshot = await config.runtime.createBackup("manual"); await sendBackupDocument(snapshot, env, config); }
  if (action === "restore") await armBackupImport(env, config);
  return true;
}
async function handleAdvancedCallback(query, data, env, config) {
  const quickView = data.match(/^quick_view:(\d{1,6})$/);
  if (quickView) {
    await answerCallback(query, config);
    const item = getQuickBank(await env.BOT_KV.get(`quick_admin_${config.adminId}`)).items.find((item) => item.id === quickView[1]);
    await renderAdminView(item ? `⚙️ ${item.id}. <b>${escapeHtml(item.title)}</b>\n\n${escapeHtml(item.text)}` : "模板已删除", { inline_keyboard: [[{ text: "⬅️ 返回模板", callback_data: "quick_manage" }]] }, env, config, query.message?.message_id);
    return true;
  }
  const manage = data.match(/^awaiting_manage:(\d{1,6})$/), clear = data.match(/^awaiting_clear:([1-9]\d{0,19}):(\d{1,6})(?::([a-f0-9]{16}))?$/);
  const setting = data.match(/^awaiting_set:(0|3|5|7)$/), confirm = data.match(/^awaiting_confirm:([a-f0-9]{16})$/);
  if (manage || clear || data === "awaiting_settings" || setting || data === "awaiting_clear_all" || confirm) {
    const kv = env.BOT_KV, messageId = query.message?.message_id;
    if (clear) {
      const context = clear[3] && parseObject(await kv.get(`admin_awaiting_clear_page_${clear[3]}`));
      const user = context?.snapshot?.find((user) => user.id === clear[1]);
      if (!context || context.owner !== config.adminId || context.messageId !== messageId || context.expiresAt <= Date.now() || !user) {
        await answerCallback(query, config, "按钮已过期或已处理，请重新打开清理页面"); return true;
      }
      if (clear[1] !== config.adminId) await clearPendingIds(clear[1], user.ids, kv);
      await answerCallback(query, config, "已清除待回复");
      await showAwaitingManagement(env, config, messageId, Number(clear[2]));
    } else if (manage) {
      await answerCallback(query, config);
      await showAwaitingManagement(env, config, messageId, Number(manage[1]));
    } else if (setting || data === "awaiting_settings") {
      await answerCallback(query, config);
      if (setting) { await kv.put("settings_awaiting", setting[1]); await sweepAwaiting(kv); }
      await showAwaitingSettings(env, config, messageId);
    } else if (data === "awaiting_clear_all") {
      await answerCallback(query, config);
      const users = await awaitingContacts(kv, config.adminId), nonce = makeNonce(), chunkCount = Math.ceil(users.length / 500);
      // 按联系人拆分，避免将所有待回复 ID 塞进一个超过存储限制的值。
      for (const user of users) await kv.put(`admin_awaiting_clear_${nonce}_user_${user.id}`, JSON.stringify({ id: user.id, ids: parseInbox(await kv.get(`inbox_${user.id}`)).pendingIds }), { expirationTtl: 300 });
      for (let i = 0; i < chunkCount; i++) await kv.put(`admin_awaiting_clear_${nonce}_ids_${i}`, JSON.stringify(users.slice(i * 500, (i + 1) * 500).map((user) => user.id)), { expirationTtl: 300 });
      const rendered = await renderAdminView(`清除全部待回复（${users.length} 人）？\n聊天记录保留，确认期间的新消息保留`, { inline_keyboard: [
        [{ text: "确认清除", callback_data: `awaiting_confirm:${nonce}` }, { text: "取消", callback_data: "awaiting_manage:0" }],
      ] }, env, config, messageId);
      if (rendered?.ok) {
        await kv.put(`admin_awaiting_clear_${nonce}`, JSON.stringify({ owner: config.adminId, messageId: rendered.result.message_id, expiresAt: Date.now() + 300000, chunkCount }), { expirationTtl: 300 });
        await kv.put(`admin_awaiting_clear_current_${config.adminId}`, nonce, { expirationTtl: 300 });
      }
    } else {
      const key = `admin_awaiting_clear_${confirm[1]}`, context = parseObject(await kv.get(key));
      if (!context || context.owner !== config.adminId || context.messageId !== messageId || context.expiresAt <= Date.now()) {
        await answerCallback(query, config, "确认已过期或已处理，请重新打开"); return true;
      }
      let count = 0;
      if (Array.isArray(context.snapshot)) {
        for (const user of context.snapshot) count += await clearPendingIds(user.id, user.ids, kv);
      } else {
        for (let i = 0; i < context.chunkCount; i++) {
          const ids = parseArray(await kv.get(`admin_awaiting_clear_${confirm[1]}_ids_${i}`));
          for (const id of ids) {
            const user = parseObject(await kv.get(`admin_awaiting_clear_${confirm[1]}_user_${id}`));
            if (user) count += await clearPendingIds(user.id, user.ids, kv);
          }
        }
      }
      await kv.delete(key);
      await kv.delete(`admin_awaiting_clear_current_${config.adminId}`);
      await answerCallback(query, config, `已清除 ${count} 条待回复`);
      await renderContactList(await buildAwaitingList(kv, config.adminId), env, config, messageId);
    }
    return true;
  }
  if (data === "backup_import_cancel") {
    await env.BOT_KV.delete(`admin_restore_input_${config.adminId}`);
    await answerCallback(query, config, "已取消导入");
    await config.runtime.showBackups(config, query.message?.message_id); return true;
  }
  const awaitingPage = data.match(/^awaiting_page:(\d+)$/);
  if (data === "awaiting" || awaitingPage) {
    await answerCallback(query, config);
    const view = await buildAwaitingList(env.BOT_KV, config.adminId, awaitingPage ? Number(awaitingPage[1]) : 0);
    await renderContactList(view, env, config, query.message?.message_id);
    return true;
  }
  if (["quick_replies", "quick_manage", "quick_add", "away_settings", "away_on", "away_off", "away_text", "backups", "backup_new", "backup_import"].includes(data)) {
    await answerCallback(query, config);
    if (data === "quick_replies") await showQuickReplies((await getActiveAdminTarget(env.BOT_KV, config.adminId))?.userId, env, config, query.message?.message_id);
    if (data === "quick_manage") await showQuickManagement(env, config, query.message?.message_id);
    if (data === "quick_add" || data === "away_text") await advancedInput(data, env, config, query.message?.message_id);
    if (data === "away_on" || data === "away_off") { const setting = await getAwaySettings(env.BOT_KV, config.adminId); await env.BOT_KV.put(`away_admin_${config.adminId}`, JSON.stringify({ ...setting, enabled: data === "away_on" })); }
    if (["away_settings", "away_on", "away_off"].includes(data)) await showAwaySettings(env, config, query.message?.message_id);
    if (data === "backups") await config.runtime.showBackups(config, query.message?.message_id);
    if (data === "backup_new") { const snapshot = await config.runtime.createBackup("manual"); const sent = await sendBackupDocument(snapshot, env, config, query.message?.message_id); await config.runtime.showBackups(config, query.message?.message_id, sent.ok ? "✅ 已创建并发送备份" : "⚠️ 备份已保存，文件发送未确认，可重试下载"); }
    if (data === "backup_import") await armBackupImport(env, config, query.message?.message_id);
    return true;
  }
  const quick = data.match(/^qsend:([a-f0-9]{16}):(\d{1,6})$/);
  if (quick) {
    const key = `admin_quick_${quick[1]}`, context = parseObject(await env.BOT_KV.get(key));
    const item = getQuickBank(await env.BOT_KV.get(`quick_admin_${config.adminId}`)).items.find((item) => item.id === quick[2]);
    const menuId = quickMenuId(context, query, config);
    if (!context || context.used || !item) {
      await Promise.allSettled([clearQuickButtons(context ? menuId : null, env, config), answerCallback(query, config, "这个快捷菜单已结束")]);
      return true;
    }
    await env.BOT_KV.put(key, JSON.stringify({ ...context, used: true }), { expirationTtl: 600 });
    await Promise.allSettled([clearQuickButtons(menuId, env, config), answerCallback(query, config, "正在发送")]);
    await deliverQuickReply(context.targetId, item, env, config, menuId); return true;
  }
  const backup = data.match(/^(backup_get|backup_preview):([a-f0-9]{16})$/);
  if (backup) {
    await answerCallback(query, config);
    const saved = await config.runtime.ctx.storage.get(`b:${backup[2]}`);
    if (!saved) { await renderAdminView("备份已过期，请刷新列表", { inline_keyboard: [[{ text: "返回备份", callback_data: "backups" }]] }, env, config, query.message?.message_id); return true; }
    if (backup[1] === "backup_get") { const sent = await sendBackupDocument(saved.snapshot, env, config, query.message?.message_id); await config.runtime.showBackups(config, query.message?.message_id, sent.ok ? "✅ 备份文件已发送" : "⚠️ 文件发送未确认，可重试下载"); }
    else await config.runtime.stageRestore(saved.snapshot, config, query.message?.message_id);
    return true;
  }
  const restore = data.match(/^(restore_confirm|restore_cancel):([a-f0-9]{16})$/);
  if (restore) {
    const resultKey = `restore_result_${restore[2]}`;
    if (await env.BOT_KV.get(resultKey)) { await answerCallback(query, config, "这次恢复已处理"); return true; }
    await answerCallback(query, config, restore[1] === "restore_cancel" ? "已取消" : "正在恢复");
    if (restore[1] === "restore_cancel") {
      await config.runtime.ctx.storage.delete(`r:${restore[2]}`);
      await env.BOT_KV.put(resultKey, "cancelled", { expirationTtl: 600 });
      await config.runtime.showBackups(config, query.message?.message_id);
    } else {
      try {
        const result = await config.runtime.restoreBackup(restore[2]);
        await env.BOT_KV.put(resultKey, "restored", { expirationTtl: 600 });
        await renderAdminView(`✅ 恢复完成：${result.restored} 条，跳过已过期 ${result.expired} 条\n当前会话已退出；恢复前的数据已自动备份`, { inline_keyboard: [[{ text: "返回备份", callback_data: "backups" }], ...getBackToMenuButtons().inline_keyboard] }, env, config, query.message?.message_id);
      } catch (error) {
        await renderAdminView(escapeHtml(`❌ 未恢复：${redactSensitiveInfo(error?.message || error, env)}`), { inline_keyboard: [[{ text: "返回备份", callback_data: "backups" }]] }, env, config, query.message?.message_id);
      }
    }
    return true;
  }
  return false;
}

function isBackupKey(key, adminId) {
  return key === "settings_awaiting" || /^(auth|lock|note|replied|recent|profile)_\d{1,20}$/.test(key) || ["settings", "away", "quick"].some((prefix) => key === `${prefix}_admin_${adminId}`);
}
const BACKUP_PREFIXES = ["auth_", "lock_", "note_", "replied_", "recent_", "profile_", "settings_", "away_", "quick_"];
async function backupEntries(kv, adminId) {
  const keys = (await Promise.all(BACKUP_PREFIXES.map((prefix) => listAllKeys(kv, prefix)))).flat().filter((item) => isBackupKey(item.name, adminId));
  if (keys.length > BACKUP_MAX_ENTRIES) throw new Error("备份超过 5000 条，请先清理历史数据");
  const values = await readMany(kv, keys.map((item) => item.name));
  return keys.sort((a, b) => a.name.localeCompare(b.name)).filter((item) => values.get(item.name) !== null).map((item) => ({ key: item.name, value: values.get(item.name), expiration: item.expiration || null, metadata: item.metadata ?? null }));
}
async function entriesChecksum(entries) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(entries)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function validateBackup(snapshot, adminId) {
  if (!snapshot || snapshot.format !== "chuanhuatong-backup" || snapshot.version !== 1 || snapshot.adminId !== String(adminId)) throw new Error("备份格式或管理员 ID 不匹配");
  if (!Number.isSafeInteger(snapshot.createdAt) || snapshot.createdAt <= 0 || snapshot.createdAt > Date.now() + 60000 || !Array.isArray(snapshot.entries) || snapshot.entries.length > BACKUP_MAX_ENTRIES) throw new Error("备份时间或数量无效");
  if (new TextEncoder().encode(JSON.stringify(snapshot)).length > BACKUP_MAX_BYTES) throw new Error("备份超过 1 MiB");
  const seen = new Set();
  for (const entry of snapshot.entries) {
    if (!entry || typeof entry.key !== "string" || !isBackupKey(entry.key, adminId) || seen.has(entry.key) || typeof entry.value !== "string") throw new Error("备份包含重复键或不允许恢复的数据");
    if (Object.keys(entry).some((field) => !["key", "value", "expiration", "metadata"].includes(field))) throw new Error("备份条目包含未知字段");
    seen.add(entry.key);
    if (entry.expiration !== null && (!Number.isSafeInteger(entry.expiration) || entry.expiration < 1)) throw new Error("备份过期时间无效");
    if (entry.metadata !== null && (typeof entry.metadata !== "object" || Array.isArray(entry.metadata) || new TextEncoder().encode(JSON.stringify(entry.metadata)).length > 1024)) throw new Error("备份元数据无效");
    if (/^(auth|replied)_/.test(entry.key) && !["true", "false"].includes(entry.value)) throw new Error("备份授权数据无效");
    if (entry.key.startsWith("lock_") && !/^\d{1,16}$/.test(entry.value)) throw new Error("备份封禁时间无效");
    if (entry.key.startsWith("note_") && (!parseContactNote(entry.value)?.text || charCount(parseContactNote(entry.value).text) > 80)) throw new Error("备份备注无效");
    if (entry.key.startsWith("recent_") && !parseObject(entry.value)) throw new Error("备份联系人数据无效");
    if (entry.key.startsWith("profile_")) {
      const profile = parseObject(entry.value);
      if (!profile || profile.id !== entry.key.slice(8) || typeof profile.firstName !== "string" || charCount(profile.firstName) > 100 || typeof profile.username !== "string" || !/^$|^[A-Za-z0-9_]{1,64}$/.test(profile.username)) throw new Error("备份昵称资料无效");
    }
    if (entry.key === `settings_admin_${adminId}`) { const minutes = parseObject(entry.value)?.idleMinutes; if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) throw new Error("备份会话设置无效"); }
    if (entry.key === "settings_awaiting" && !["0", "3", "5", "7"].includes(entry.value)) throw new Error("备份待回复设置无效");
    if (entry.key === `away_admin_${adminId}`) { const value = parseObject(entry.value); if (typeof value?.enabled !== "boolean" || typeof value.text !== "string" || !value.text.trim() || charCount(value.text) > 500) throw new Error("备份离开设置无效"); }
    if (entry.key === `quick_admin_${adminId}`) {
      const bank = parseObject(entry.value), ids = new Set();
      if (!bank || !Array.isArray(bank.items) || bank.items.length > 10 || !Number.isInteger(bank.nextId) || bank.nextId < 1 || bank.nextId > 1000000) throw new Error("备份模板无效");
      for (const item of bank.items) {
        if (!item || !/^\d{1,6}$/.test(item.id) || ids.has(item.id) || Number(item.id) >= bank.nextId || typeof item.title !== "string" || !item.title.trim() || charCount(item.title) > 20 || typeof item.text !== "string" || !item.text.trim() || charCount(item.text) > 1000) throw new Error("备份模板内容无效");
        ids.add(item.id);
      }
    }
  }
  if (snapshot.checksum !== await entriesChecksum(snapshot.entries)) throw new Error("备份校验失败，文件可能被改动");
  // 只保留协议字段，不保留导入文件中额外的数据。
  return { format: snapshot.format, version: 1, adminId: String(adminId), createdAt: snapshot.createdAt, entries: snapshot.entries.map(({ key, value, expiration, metadata }) => ({ key, value, expiration, metadata })), checksum: snapshot.checksum };
}
async function sendBackupDocument(snapshot, env, config, messageId = null) {
  const form = new FormData(), filename = `chuanhuatong-backup-${new Date(snapshot.createdAt).toISOString().replace(/[:.]/g, "-")}.json`;
  form.set("chat_id", config.adminId); form.set("caption", "传话筒数据备份：包含访客资料，仅自己保存。");
  form.set("document", new Blob([JSON.stringify(snapshot)], { type: "application/json" }), filename);
  const started = Date.now();
  try {
    const response = await fetch(`${config.apiUrl}sendDocument`, { method: "POST", body: form, signal: AbortSignal.timeout(20000) });
    const result = await safeJson(response);
    if (config.runtime) await config.runtime.recordApi("sendDocument", Date.now() - started, result.ok, result.description);
    if (!result.ok && !messageId) await sendMessage(config.adminId, `❌ 文件发送失败；备份已保存，可在备份列表重新下载\n${formatDeliveryFailure(result.description)}`, env, config);
    return result;
  } catch (error) {
    if (config.runtime) await config.runtime.recordFailure("备份下载", error?.message || error);
    if (!messageId) await sendMessage(config.adminId, "❌ 文件发送未确认；备份已保存，可在备份列表重新下载", env, config); return { ok: false };
  }
}
async function armBackupImport(env, config, messageId = null) {
  const result = await renderAdminView("📂 请发送备份 JSON 文件，导入后先预览，确认才恢复", { inline_keyboard: [[{ text: "取消导入", callback_data: "backup_import_cancel" }], ...getBackToMenuButtons().inline_keyboard] }, env, config, messageId);
  if (result?.ok) await env.BOT_KV.put(`admin_restore_input_${config.adminId}`, JSON.stringify({ messageId: result.result?.message_id || messageId }), { expirationTtl: 600 });
}
async function readBackupDocument(document, env, config) {
  if (document.file_size > BACKUP_MAX_BYTES || !/\.json$/i.test(document.file_name || "")) throw new Error("请上传不超过 1 MiB 的 JSON 备份");
  const response = await safeJson(await callApi("getFile", { file_id: document.file_id }, config));
  const info = response.result, path = info?.file_path;
  if (!response.ok || typeof path !== "string" || !/^[A-Za-z0-9_./-]+$/.test(path) || path.split("/").some((part) => part === "..") || path.startsWith("/") || info.file_size > BACKUP_MAX_BYTES) throw new Error("无法获取备份文件");
  const file = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${path}`, { signal: AbortSignal.timeout(20000) });
  if (!file.ok || Number(file.headers.get("content-length")) > BACKUP_MAX_BYTES) throw new Error("备份下载失败或文件过大");
  const reader = file.body?.getReader();
  if (!reader) throw new Error("备份文件为空");
  const chunks = []; let size = 0;
  while (true) {
    const chunk = await reader.read(); if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > BACKUP_MAX_BYTES) { await reader.cancel(); throw new Error("备份超过 1 MiB"); }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let snapshot;
  try { snapshot = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Error("备份不是有效 UTF-8 JSON"); }
  return validateBackup(snapshot, config.adminId);
}

// UTF-16 孤立代理项无法表示有效 Unicode 字符，发送前替换为 U+FFFD。
function toSafeUnicode(value) {
  const text = String(value ?? "");
  if (typeof text.toWellFormed === "function") return text.toWellFormed();
  return Array.from(text, (char) => {
    const code = char.charCodeAt(0);
    return char.length === 1 && code >= 0xD800 && code <= 0xDFFF ? "\uFFFD" : char;
  }).join("");
}

function truncateText(text, maxLength) {
  const chars = Array.from(toSafeUnicode(text || ""));
  return chars.length > maxLength ? `${chars.slice(0, maxLength).join("")}…` : chars.join("");
}

// Telegram 单条消息上限 4096 字符；超长时截断，避免整条发送 / 编辑失败
function clampText(text) {
  const value = toSafeUnicode(text);
  if (value.length <= TG_TEXT_LIMIT) return value;
  // 在换行处截断，避免切断 HTML 标签
  const cut = value.lastIndexOf("\n", TG_TEXT_LIMIT - 20);
  const prefix = value.slice(0, cut > 0 ? cut : TG_TEXT_LIMIT - 20).replace(/[\uD800-\uDBFF]$/, "");
  return `${prefix}\n…（内容过长已截断）`;
}

// 按实际显示长度截断，保持 HTML 标签与实体完整；不会把 href 或 &amp; 切成半段。
function clampHtml(html) {
  const value = toSafeUnicode(html), stack = [], parts = [];
  const suffix = "\n…（内容过长已截断）", budget = TG_TEXT_LIMIT - suffix.length;
  let visible = 0, truncated = false;
  const tokens = value.match(/<[^>]*>|&(?:amp|lt|gt|quot|#\d+|#x[0-9a-f]+);|[^<&]+|[<&]/giu) || [];
  const entityUnits = (token) => {
    const numeric = token.match(/^&#(x[0-9a-f]+|\d+);$/i);
    return token.startsWith("&") && token.endsWith(";") ? numeric && Number.parseInt(numeric[1].replace(/^x/i, ""), /^x/i.test(numeric[1]) ? 16 : 10) > 0xffff ? 2 : 1 : token.length;
  };
  if (tokens.reduce((total, token) => total + (token.startsWith("<") && token.endsWith(">") ? 0 : entityUnits(token)), 0) <= TG_TEXT_LIMIT) return value;
  for (const token of tokens) {
    if (token.startsWith("<") && token.endsWith(">")) {
      const closing = token.match(/^<\/([a-z0-9-]+)\s*>$/i), opening = token.match(/^<([a-z0-9-]+)\b/i);
      parts.push(token);
      if (closing) stack.pop();
      else if (opening && !token.endsWith("/>")) stack.push(opening[1]);
      continue;
    }
    const units = entityUnits(token);
    if (visible + units > budget) {
      if (!(token.startsWith("&") && token.endsWith(";"))) {
        let prefix = token.slice(0, Math.max(0, budget - visible)).replace(/[\uD800-\uDBFF]$/, "");
        parts.push(prefix);
      }
      truncated = true; break;
    }
    visible += units; parts.push(token);
  }
  if (!truncated) return value;
  return parts.join("") + suffix + stack.reverse().map((tag) => `</${tag}>`).join("");
}

async function formatTargetLabel(kv, userId) {
  const recentUser = await getRecentUserById(kv, userId);
  const name = recentUser?.firstName || recentUser?.username || "这个访客";
  return `${name} ${userId}`;
}

function formatDeliveryFailure(description) {
  const reason = String(description || "未知错误");
  if (/bot was blocked by the user/i.test(reason)) return "原因：对方已拉黑机器人";
  if (/user is deactivated/i.test(reason)) return "原因：对方账号已注销";
  if (/chat not found/i.test(reason)) return "原因：找不到这个会话";
  return `原因：${reason}`;
}

function escapeMarkdownV2(input) { return toSafeUnicode(input).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&"); }
function escapeHtml(input) {
  return toSafeUnicode(input)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function fetchWithTimeout(url, options, timeoutMs = 12000) {
  if (typeof AbortController === "undefined") return fetch(url, options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

// 实时协调器：原有 KV 数据按需读取；即时状态持久化后，再限速同步回原 KV。
// 所有入口使用同一实例，避免网页验证和 Webhook 读到不同地区的授权缓存。
async function listNativeRecords(storage, prefix) {
  const result = new Map();
  let after;
  do {
    const page = await storage.list({ prefix, limit: 1000, ...(after ? { startAfter: after } : {}) });
    for (const [key, value] of page) result.set(key, value);
    if (page.size < 1000) break;
    after = [...page.keys()].at(-1);
  } while (after);
  return result;
}

export class BotCoordinator extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.store = new CoordinatedStore(ctx.storage, env.BOT_KV);
    this.queue = Promise.resolve();
    this.uiQueues = new Map();
  }

  runExclusive(task) {
    const result = this.queue.then(task);
    this.queue = result.then(() => {}, () => {});
    return result;
  }

  runUiExclusive(key, task) {
    const previous = this.uiQueues.get(key) || Promise.resolve();
    const result = previous.then(task), settled = result.then(() => {}, () => {});
    this.uiQueues.set(key, settled);
    settled.then(() => { if (this.uiQueues.get(key) === settled) this.uiQueues.delete(key); });
    return result;
  }

  fetch(request) {
    return this.runExclusive(async () => {
      let updateId = null;
      let incomingMessage = null;
      if (new URL(request.url).pathname !== "/verify-submit") {
        try {
          const body = await request.clone().json();
          incomingMessage = body?.message;
          if (Number.isSafeInteger(body?.update_id) && body.update_id >= 0) updateId = String(body.update_id);
        } catch {}
      }
      if (updateId) {
        const seen = await this.ctx.storage.get(`u:${updateId}`);
        if (seen && seen > Date.now()) return new Response("OK");
      }
      const runtimeEnv = { ...this.env, BOT_KV: this.store, __botRuntime: this };
      const runtimeCtx = { waitUntil: (promise) => this.ctx.waitUntil(promise) };
      const started = Date.now();
      if (incomingMessage?.chat?.type === "private" && !incomingMessage.media_group_id) {
        // 发送者已经开始发下一条消息时，先结束其前一组相册，减少消息顺序颠倒。
        const waiting = await listNativeRecords(this.ctx.storage, `a:${incomingMessage.chat.id}:`);
        for (const [key, job] of waiting) if (job.state === "pending" && !(job.attempts > 0)) await this.processAlbum(key, job);
      }
      const response = await handleRequest(request, runtimeEnv, runtimeCtx);
      if (updateId && response.ok) {
        await this.ctx.storage.put(`u:${updateId}`, Date.now() + 24 * 60 * 60 * 1000);
        await this.store.scheduleAlarm();
      }
      await this.recordRequest(Date.now() - started, response.status);
      return response;
    });
  }

  async alarm() {
    await this.runExclusive(async () => {
      await this.processAlbums();
      await this.processMessageEdits();
      const lastAwaitingSweep = await this.ctx.storage.get("d:awaiting_sweep") || 0;
      if (Date.now() - lastAwaitingSweep >= 3600000) {
        await migrateContactProfiles(this.store);
        await sweepAwaiting(this.store);
        await this.ctx.storage.put("d:awaiting_sweep", Date.now());
      }
      await this.store.sweepExpired();
      await this.sweepRestorePreviews();
      await this.rescheduleAlarm();
    });
    // KV 镜像本身有版本校验，可在队列外运行，避免慢 KV 同步拖住聊天。
    if (!this.mirrorTask) {
      this.mirrorTask = this.store.flushMirrors().then(async (result) => {
        if (result.failedCount && (!this.lastMirrorErrorAt || Date.now() - this.lastMirrorErrorAt >= 60000)) {
          this.lastMirrorErrorAt = Date.now();
          await this.recordFailure("KV 同步", `${result.failedCount} 条写入未完成：${result.lastError}`);
        }
      }).catch(async (error) => {
        console.warn("KV sync postponed:", redactSensitiveInfo(error?.message || error, this.env));
        await this.recordFailure("KV 同步", error?.message || error);
      }).finally(() => { this.mirrorTask = null; });
    }
    await this.mirrorTask;
    await this.runExclusive(() => this.rescheduleAlarm());
  }

  async createBackup(reason = "manual") {
    const adminId = String(this.env.MY_ADMIN_ID), entries = await backupEntries(this.store, adminId);
    const snapshot = { format: "chuanhuatong-backup", version: 1, adminId, createdAt: Date.now(), entries, checksum: await entriesChecksum(entries) };
    await validateBackup(snapshot, adminId);
    const nonce = makeNonce();
    await this.ctx.storage.put(`b:${nonce}`, { reason, snapshot });
    const saved = await listNativeRecords(this.ctx.storage, "b:");
    const sorted = [...saved.entries()].sort((a, b) => b[1].snapshot.createdAt - a[1].snapshot.createdAt || (a[0] === `b:${nonce}` ? -1 : b[0] === `b:${nonce}` ? 1 : a[0].localeCompare(b[0])));
    for (const [key] of sorted.slice(BACKUP_LIMIT)) await this.ctx.storage.delete(key);
    return snapshot;
  }

  async showBackups(config, messageId = null, notice = "") {
    const backups = [...(await listNativeRecords(this.ctx.storage, "b:")).entries()].sort((a, b) => b[1].snapshot.createdAt - a[1].snapshot.createdAt);
    const rows = backups.slice(0, BACKUP_LIMIT).map(([key, saved]) => [
      { text: `📥 ${formatTimestamp(saved.snapshot.createdAt)}`, callback_data: `backup_get:${key.slice(2)}` },
      { text: "恢复", callback_data: `backup_preview:${key.slice(2)}` },
    ]);
    rows.push([{ text: "➕ 创建并下载", callback_data: "backup_new" }, { text: "📂 导入 JSON", callback_data: "backup_import" }], [{ text: "⬅️ 返回菜单", callback_data: "menu_main" }]);
    await renderAdminView(`💾 数据备份（${backups.length}/${BACKUP_LIMIT}）\n━━━━━━━━━━━━━━\n备注、授权、封禁、联系人记录与管理设置\n恢复会替换这些数据，先预览再确认${notice ? `\n\n${escapeHtml(notice)}` : ""}`, { inline_keyboard: rows }, { ...this.env, BOT_KV: this.store }, config, messageId);
  }

  async stageRestore(snapshot, config, messageId = null) {
    snapshot = await validateBackup(snapshot, String(this.env.MY_ADMIN_ID));
    const nonce = makeNonce(), counts = {};
    for (const { key } of snapshot.entries) { const prefix = key.split("_")[0]; counts[prefix] = (counts[prefix] || 0) + 1; }
    const rendered = await renderAdminView(`💾 恢复预览\n备份时间：${escapeHtml(formatTimestamp(snapshot.createdAt))}\n授权 ${counts.auth || 0}｜封禁 ${counts.lock || 0}｜备注 ${counts.note || 0}\n联系人 ${counts.recent || 0}｜昵称 ${counts.profile || 0}｜回复记录 ${counts.replied || 0}\n设置 ${(counts.settings || 0) + (counts.away || 0) + (counts.quick || 0)}\n\n将替换当前对应数据；已过期条目会跳过。恢复前自动创建一份备份。\n确认有效期：10 分钟`, { inline_keyboard: [
      [{ text: "✅ 确认恢复", callback_data: `restore_confirm:${nonce}` }, { text: "取消", callback_data: `restore_cancel:${nonce}` }],
    ] }, { ...this.env, BOT_KV: this.store }, config, messageId);
    if (rendered?.ok) {
      await this.ctx.storage.put(`r:${nonce}`, { snapshot, owner: config.adminId, messageId: rendered.result?.message_id || messageId, expiresAt: Date.now() + 600000 });
      await this.store.scheduleAlarm();
    }
  }

  async restoreBackup(nonce) {
    const key = `r:${nonce}`, pending = await this.ctx.storage.get(key), adminId = String(this.env.MY_ADMIN_ID);
    if (!pending || pending.owner !== adminId || pending.expiresAt <= Date.now()) throw new Error("确认已过期或已使用，请重新预览");
    const snapshot = await validateBackup(pending.snapshot, adminId);
    const current = await backupEntries(this.store, adminId);
    await this.createBackup("before_restore");
    const now = Math.floor(Date.now() / 1000), restored = snapshot.entries.filter((entry) => !entry.expiration || entry.expiration > now);
    const desired = new Map(restored.map((entry) => [entry.key, entry]));
    const keys = new Set([...current.map((entry) => entry.key), ...snapshot.entries.map((entry) => entry.key), `active_admin_${adminId}`, `admin_input_${adminId}`, `admin_restore_input_${adminId}`, `admin_search_${adminId}`]);
    // 恢复后使旧快捷回复菜单失效，防止旧菜单继续使用恢复前的模板。
    for (const item of await listAllKeys(this.store, "admin_quick_")) keys.add(item.name);
    for (const item of await listAllKeys(this.store, "admin_awaiting_clear_")) keys.add(item.name);
    await this.ctx.storage.transaction(async (txn) => {
      const latest = await txn.get(key);
      if (!latest || latest.expiresAt <= Date.now()) throw new Error("确认已过期或已使用");
      const names = [...keys];
      for (let start = 0; start < names.length; start += 50) {
        const batch = names.slice(start, start + 50), existing = await txn.get(batch.map((name) => `v:${name}`)), writes = {};
        for (const name of batch) {
          const entry = desired.get(name), record = { value: entry?.value ?? null, deleted: !entry, metadata: entry?.metadata ?? null, expiration: entry?.expiration ?? null, revision: (existing.get(`v:${name}`)?.revision || 0) + 1 };
          writes[`v:${name}`] = record; writes[`o:${name}`] = record;
        }
        await txn.put(writes);
      }
      await txn.delete(key);
    });
    await this.store.scheduleAlarm();
    return { restored: restored.length, expired: snapshot.entries.length - restored.length };
  }

  async sweepRestorePreviews() {
    const pending = await listNativeRecords(this.ctx.storage, "r:");
    for (const [key, record] of pending) if (record.expiresAt <= Date.now()) await this.ctx.storage.delete(key);
  }

  async updateDiagnostics(task) {
    try {
      await this.ctx.storage.transaction(async (txn) => {
        const stats = await txn.get("d:stats") || {};
        task(stats);
        await txn.put("d:stats", stats);
      });
    } catch { console.warn("Diagnostics storage unavailable"); }
  }

  async recordFailure(label, reason) {
    await this.updateDiagnostics((stats) => {
      stats.failures = [...(stats.failures || []), { at: Date.now(), label: truncateText(label, 60), reason: truncateText(redactSensitiveInfo(reason, this.env), 240) }].slice(-10);
    });
  }

  async recordApi(method, elapsed, ok, reason) {
    await this.updateDiagnostics((stats) => {
      stats.apiSamples = [...(stats.apiSamples || []), Math.max(0, elapsed)].slice(-100);
      stats.apiCount = stats.apiSamples.length;
      stats.apiTotalMs = stats.apiSamples.reduce((sum, value) => sum + value, 0);
      if (!ok && method !== "deleteMessage") stats.failures = [...(stats.failures || []), { at: Date.now(), label: method, reason: truncateText(redactSensitiveInfo(reason || "接口失败", this.env), 240) }].slice(-10);
    });
  }

  async recordRequest(elapsed, status) {
    await this.updateDiagnostics((stats) => {
      stats.lastRequestAt = Date.now(); stats.lastRequestMs = elapsed; stats.lastRequestStatus = status;
    });
  }

  async diagnostics() {
    const [stats, mirrors, albums] = await Promise.all([this.ctx.storage.get("d:stats"), this.ctx.storage.list({ prefix: "o:", limit: 1000 }), listNativeRecords(this.ctx.storage, "a:")]);
    const jobs = [...albums.values()];
    return { stats: stats || {}, mirrors: mirrors.size, albums: jobs.filter((job) => ["pending", "sending", "sent"].includes(job.state)).length, failedAlbums: jobs.filter((job) => ["failed", "uncertain"].includes(job.state)).length };
  }

  albumKey(msg) {
    const group = String(msg.media_group_id);
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(group) || !Number.isSafeInteger(msg.message_id) || msg.message_id <= 0) throw new Error("无效的相册消息");
    return `a:${msg.chat.id}:${group}`;
  }

  async enqueueUserAlbum(msg, chatId, now, env, config) {
    const key = this.albumKey(msg), previous = await this.ctx.storage.get(key);
    if (!previous) {
      const rate = await checkAndConsumeRateLimit(chatId, now, env);
      if (rate.blocked) {
        await this.ctx.storage.put(key, { state: "denied", ids: [msg.message_id], createdAt: now, updatedAt: now });
        await this.store.scheduleAlarm();
        await sendMessage(chatId, `⏳ 发得有点快啦\n${rate.retryAfter} 秒后再试试吧~`, env, config);
        return;
      }
    } else if (["denied", "failed", "uncertain"].includes(previous.state)) return;
    await this.enqueueAlbum(msg, config.adminId, "visitor", "visitor");
  }

  async enqueueAdminAlbum(msg, env, config) {
    const key = this.albumKey(msg), previous = await this.ctx.storage.get(key);
    if (previous?.seenIds?.includes(msg.message_id) || previous?.ids?.includes(msg.message_id)) return;
    let targetId = previous?.targetId, route = previous?.route;
    if (msg.reply_to_message) {
      const repliedId = await this.store.get(`msg_${msg.reply_to_message.message_id}`);
      if (!repliedId || (route === "reply" && targetId && targetId !== repliedId)) {
        const reason = repliedId ? "同一相册不能回复不同联系人" : "相册回复映射已失效，请重新选择联系人发送";
        await this.ctx.storage.put(key, { ...(previous || {}), state: "failed", createdAt: previous?.createdAt || Date.now(), updatedAt: Date.now() });
        await this.recordFailure("相册回复", reason);
        await sendMessage(config.adminId, reason, env, config);
        return;
      }
      if (!previous || previous.state === "pending") { targetId = repliedId; route = "reply"; }
    }
    if (!previous && !targetId) { targetId = (await getActiveAdminTarget(this.store, config.adminId))?.userId; route = "active"; }
    if (previous && ["failed", "uncertain", "denied"].includes(previous.state)) return;
    if (route === "reply" && targetId) {
      const recent = await getRecentUserById(this.store, targetId);
      await setActiveAdminTarget(this.store, config.adminId, targetId, recent?.firstName || `访客${targetId}`);
    }
    await this.enqueueAlbum(msg, targetId || null, "admin", route);
  }

  async enqueueAlbum(msg, targetId, kind, route) {
    const key = this.albumKey(msg), now = Date.now();
    let job = await this.ctx.storage.get(key);
    if (job && now - (job.updatedAt || job.createdAt) > ALBUM_RECORD_TTL_MS) job = null;
    if (job?.seenIds?.includes(msg.message_id) || job?.ids?.includes(msg.message_id)) return;
    if (job && !["pending", "done"].includes(job.state)) return;
    const late = job?.state === "done";
    const createdAt = !job || late ? now : job.createdAt;
    const ids = [...(!job || late ? [] : job.ids), msg.message_id].sort((a, b) => a - b);
    if (ids.length > 100) throw new Error("相册消息超过批量上限");
    job = { ...job, kind, route: route || job?.route, targetId: targetId || job?.targetId || null,
      messages: { ...(!job || late ? {} : job.messages), [msg.message_id]: albumSource(msg) },
      fromId: String(msg.chat.id), state: "pending", ids, seenIds: [...new Set([...(job?.seenIds || []), ...ids])].slice(-200),
      createdAt, updatedAt: now, dueAt: Math.min(now + ALBUM_QUIET_MS, createdAt + ALBUM_MAX_WAIT_MS), attempts: 0 };
    await this.ctx.storage.put(key, job);
    await this.wakeAt(job.dueAt);
  }

  async updateQueuedAlbumContent(msg) {
    const key = this.albumKey(msg), job = await this.ctx.storage.get(key);
    if (job?.state !== "pending" || !job.ids.includes(msg.message_id)) return;
    if (Number(msg.edit_date || 0) < Number(job.messages?.[msg.message_id]?.edit_date || 0)) return;
    job.messages = { ...(job.messages || {}), [msg.message_id]: albumSource(msg) };
    await this.ctx.storage.put(key, job);
  }

  async wakeAt(due) {
    const current = await this.ctx.storage.getAlarm();
    if (!current || current > due) await this.ctx.storage.setAlarm(due);
  }

  async rescheduleAlarm() {
    const pending = await this.ctx.storage.list({ prefix: "o:", limit: 1 });
    let due = Date.now() + (pending.size ? 2000 : 60 * 60 * 1000);
    const jobs = await listNativeRecords(this.ctx.storage, "a:");
    for (const job of jobs.values()) if (["pending", "sending", "sent"].includes(job.state)) due = Math.min(due, Math.max(Date.now() + 1, Number(job.dueAt) || Date.now() + 1));
    for (const job of (await listNativeRecords(this.ctx.storage, "e:")).values()) due = Math.min(due, Math.max(Date.now() + 1, job.dueAt));
    await this.ctx.storage.setAlarm(due);
  }

  async queueMessageEdit(msg, updateId, delay, attempts = 0, uncertain = false) {
    const key = `e:${msg.chat.id}:${msg.message_id}`, previous = await this.ctx.storage.get(key), now = Date.now();
    const date = Number(msg.edit_date) || 0;
    if (previous && (date < previous.message.edit_date || (date === previous.message.edit_date && Number(updateId) < previous.updateId))) return;
    const job = { message: editedSource(msg), updateId: Number(updateId) || 0, attempts, uncertain: uncertain || previous?.uncertain || false, dueAt: now + Math.max(1, delay), createdAt: previous?.createdAt || now };
    await this.ctx.storage.put(key, job); await this.wakeAt(job.dueAt);
  }

  async processMessageEdits() {
    const env = { ...this.env, BOT_KV: this.store, __botRuntime: this }, config = getConfig(env);
    config.waitUntil = (promise) => this.ctx.waitUntil(promise);
    let count = 0;
    for (const [key, job] of await listNativeRecords(this.ctx.storage, "e:")) {
      if (Date.now() - job.createdAt > 24 * 60 * 60 * 1000) { await this.ctx.storage.delete(key); continue; }
      if (job.dueAt > Date.now() || count++ >= 20) continue;
      await handleEditedMessage(job.message, job.updateId, env, config, job.attempts);
    }
  }

  async processAlbums() {
    const jobs = await listNativeRecords(this.ctx.storage, "a:");
    let processed = 0;
    for (const [key, job] of jobs) {
      if (Date.now() - (job.updatedAt || job.createdAt) > ALBUM_RECORD_TTL_MS) { await this.ctx.storage.delete(key); continue; }
      if (processed >= 20 || !["pending", "sending", "sent"].includes(job.state) || (job.state === "pending" && job.dueAt > Date.now())) continue;
      processed++;
      await this.processAlbum(key, job);
    }
  }

  async processAlbum(key, job) {
    const env = { ...this.env, BOT_KV: this.store, __botRuntime: this }, config = getConfig(env);
    config.waitUntil = (promise) => this.ctx.waitUntil(promise);
    if (job.state === "sending") {
      job.state = "uncertain"; job.updatedAt = Date.now();
      await this.ctx.storage.put(key, job);
      await this.recordFailure("相册结果待确认", "上次发送在返回确认前中断，请检查聊天记录后决定是否重发");
      runOptionalTask(config, env, "相册通知", () => sendMessage(config.adminId, "⚠️ 上次相册发送结果待确认，请检查聊天记录", env, config));
      return;
    }
    if (job.state === "pending") {
      const visitorAllowed = job.kind !== "visitor" || ((await this.store.get(`auth_${job.fromId}`)) === "true" && !(Number(await this.store.get(`lock_${job.fromId}`)) > Date.now()));
      const targetBlocked = job.kind === "admin" && job.targetId && await isOutboundBlocked(job.targetId, env, config);
      if (!visitorAllowed || !job.targetId || targetBlocked) {
        job.state = "failed"; job.updatedAt = Date.now(); await this.ctx.storage.put(key, job);
        const reason = targetBlocked ? "该联系人正在封禁中，请先解封" : visitorAllowed ? "请先选择联系人，再发送相册" : "授权已失效，请重新发送 /start";
        runOptionalTask(config, env, "相册提示", () => sendMessage(job.fromId, reason, env, config));
        await this.recordFailure("相册未发送", reason);
        return;
      }
      job.state = "sending"; job.updatedAt = Date.now();
      if (job.kind === "admin") job.pendingIds = parseInbox(await this.store.get(`inbox_${job.targetId}`)).pendingIds;
      await this.ctx.storage.put(key, job);
      let result;
      const forwarded = Object.values(job.messages || {}).some(hasForwardOrigin);
      try { result = await safeJson(await callApi(forwarded ? "forwardMessages" : "copyMessages", { chat_id: job.targetId, from_chat_id: job.fromId, message_ids: job.ids }, config)); }
      catch (error) {
        job.state = "uncertain"; job.updatedAt = Date.now(); await this.ctx.storage.put(key, job);
        await this.recordFailure("相册结果待确认", error?.message || error);
        runOptionalTask(config, env, "相册通知", () => sendMessage(config.adminId, "⚠️ 相册发送遇到网络错误，结果待确认，请检查聊天记录", env, config));
        return;
      }
      if (!result.ok) {
        const retryAfter = Number(result.parameters?.retry_after);
        if (result.error_code === 429 && Number.isFinite(retryAfter) && retryAfter > 0 && (job.attempts || 0) < 3) {
          job.state = "pending"; job.attempts = (job.attempts || 0) + 1; job.dueAt = Date.now() + Math.min(3600, retryAfter) * 1000; job.updatedAt = Date.now();
          await this.ctx.storage.put(key, job); return;
        }
        job.state = "failed"; job.updatedAt = Date.now(); await this.ctx.storage.put(key, job);
        runOptionalTask(config, env, "相册失败提示", async () => {
          await sendMessage(job.fromId, "❌ 相册未能送达，请稍后重发", env, config, {}, { notifyOnFail: false });
          if (job.kind === "visitor") await safeNotifyAdmin(env, config, `❌ 相册转发失败\n来源：${job.fromId}\n${formatDeliveryFailure(result.description)}`);
        });
        return;
      }
      job.transport = forwarded ? "forward" : "copy";
      job.state = "sent"; job.resultIds = (Array.isArray(result.result) ? result.result : []).map((item) => item.message_id).filter(Number.isSafeInteger);
      job.updatedAt = Date.now(); await this.ctx.storage.put(key, job);
    }
    if (job.kind === "visitor") {
      for (const id of job.resultIds) await this.store.put(`msg_${id}`, job.fromId, { expirationTtl: MSG_MAP_TTL });
    } else if (job.resultIds.length) await recordAdminCommunication(job.targetId, env, config, job);
    const complete = job.resultIds.length === job.ids.length;
    if (complete) {
      for (let index = 0; index < job.ids.length; index++) {
        const original = job.messages?.[job.ids[index]];
        if (original) await recordMessageOrigin(original, job.targetId, job.resultIds[index], job.kind, env, { bodyType: "caption", transport: job.transport || (job.kind === "visitor" ? "forward" : "copy"),
          replyMarkup: job.transport === "forward" ? null : preservedRelayButtons(original), baseReplyMarkup: preservedRelayButtons(original), relayContact: false });
      }
    }
    if (job.kind === "visitor" && job.resultIds.length) {
      // 部分送达时 Telegram 不提供被跳过的来源 ID，只按一批计待回复，避免误配编辑映射。
      for (const id of complete ? job.ids : job.ids.slice(0, 1)) await recordIncomingMessage(job.fromId, id, this.store);
      await maybeSendAwayNotice(job.fromId, env, config);
    }
    if (job.resultIds.length && !job.attributionStarted) {
      job.attributionStarted = true;
      await this.ctx.storage.put(key, job);
      const name = (await getRecentUserById(this.store, job.fromId))?.firstName;
      for (let index = 0; index < job.resultIds.length; index++) {
        // 部分送达时无法对应原始成员，不猜测或覆盖已有资源按钮。
        if (!complete && index > 0) continue;
        const source = complete ? job.messages?.[job.ids[index]] || {} : {};
        const baseMarkup = preservedRelayButtons(source);
        if (job.transport === "forward") {
          if (job.kind === "visitor" && index === 0) {
            // 部分送达无法识别实际成员的原键盘，继续使用引用；完整相册只在一个成员挂入口。
            const nativeButtons = complete ? nativeForwardButtons(source) : null;
            const attached = nativeButtons !== null && await retainVisitorRelayButton(job.fromId, job.ids[0], job.resultIds[0], name, nativeButtons, env, config);
            if (!attached) await sendRelayAttribution(job.fromId, complete ? job.ids[0] : null, job.resultIds[0], name, env, config);
            if (complete) {
              const originKey = `origin_${job.fromId}_${job.ids[0]}`, origin = parseObject(await this.store.get(originKey));
              if (origin) await this.store.put(originKey, JSON.stringify({ ...origin, relayContact: attached, replyMarkup: attached ? visitorRelayButtons(job.fromId, name, nativeButtons) : null,
                ...(nativeButtons !== null ? { baseReplyMarkup: nativeButtons } : {}) }), { expirationTtl: MSG_MAP_TTL });
            }
          }
          continue;
        }
        if (job.kind === "visitor" && index === 0 && complete) {
          const attached = await retainVisitorRelayButton(job.fromId, job.ids[0], job.resultIds[0], name, baseMarkup, env, config);
          if (!attached) await sendRelayAttribution(job.fromId, job.ids[0], job.resultIds[0], name, env, config);
          const originKey = `origin_${job.fromId}_${job.ids[0]}`, origin = parseObject(await this.store.get(originKey));
          if (origin) await this.store.put(originKey, JSON.stringify({ ...origin, relayContact: attached, replyMarkup: attached ? visitorRelayButtons(job.fromId, name, baseMarkup) : baseMarkup }), { expirationTtl: MSG_MAP_TTL });
        } else if (complete && baseMarkup.inline_keyboard.length) {
          try { await callApi("editMessageReplyMarkup", { chat_id: job.targetId, message_id: job.resultIds[index], reply_markup: baseMarkup }, { ...config, apiTimeoutMs: 1500 }); }
          catch (error) { console.warn("相册按钮恢复失败:", redactSensitiveInfo(error?.message || error, env)); }
        }
      }
      if (job.kind === "visitor" && !complete && job.transport !== "forward") await sendRelayAttribution(job.fromId, null, job.resultIds[0], name, env, config);
    }
    job.state = "done"; job.updatedAt = Date.now(); await this.ctx.storage.put(key, job);
    if (!complete) await this.recordFailure("相册部分送达", `来源 ${job.fromId}：${job.resultIds.length}/${job.ids.length} 条`);
    if (job.kind === "visitor") await sendDeliveryReceipt(job.fromId, env, config, complete ? "✌︎˶╹ꇴ╹˶✌︎ 相册送出啦~" : `⚠️ 相册送达 ${job.resultIds.length}/${job.ids.length} 条，请检查后补发未送达内容`);
    else await sendAutoDeleteHtmlMessage(config.adminId, `${complete ? "✅ 相册已发送" : `⚠️ 相册送达 ${job.resultIds.length}/${job.ids.length} 条`}\n对象 ID：<code>${escapeHtml(job.targetId)}</code>`, env, config);
  }
}

class CoordinatedStore {
  constructor(storage, legacy) {
    this.storage = storage;
    this.legacy = legacy;
    this.supportsBulkReads = true;
  }

  async isImported(key) {
    const prefix = key.includes("_") ? key.slice(0, key.indexOf("_") + 1) : key;
    return !!(await this.storage.get("i:"))?.done || !!(await this.storage.get(`i:${prefix}`))?.done;
  }

  active(record) {
    return record && !record.deleted && (!record.expiration || record.expiration > Date.now() / 1000);
  }

  async get(key, type = "text") {
    if (Array.isArray(key)) {
      const prefixes = new Set(key.map((name) => name.includes("_") ? name.slice(0, name.indexOf("_") + 1) : name));
      for (const prefix of prefixes) await this.importPrefix(prefix);
      const result = new Map();
      for (let start = 0; start < key.length; start += 100) {
        const batch = key.slice(start, start + 100);
        const local = await this.storage.get(batch.map((name) => `v:${name}`));
        for (const name of batch) {
          const record = local.get(`v:${name}`);
          result.set(name, this.decode(record, type));
        }
      }
      return result;
    }
    let record = await this.storage.get(`v:${key}`);
    if (record === undefined) {
      let value = null, metadata = null, expiration = null;
      if (!(await this.isImported(key))) {
        value = await this.legacy.get(key);
        if (value !== null) {
          const listing = await this.legacy.list({ prefix: key, limit: 1 });
          const info = listing.keys.find((item) => item.name === key);
          metadata = info?.metadata ?? null;
          expiration = info?.expiration || null;
        }
      }
      record = { value, metadata, expiration, deleted: value === null, revision: 0 };
      await this.storage.transaction(async (txn) => {
        const existing = await txn.get(`v:${key}`);
        if (existing === undefined) await txn.put(`v:${key}`, record);
        else record = existing;
      });
    }
    return this.decode(record, type);
  }

  decode(record, type) {
    if (!this.active(record)) return null;
    if (type === "json" || type?.type === "json") {
      try { return JSON.parse(record.value); } catch { return null; }
    }
    return record.value;
  }

  async put(key, value, options = {}) {
    await this.write(key, { value: String(value), deleted: false, metadata: options.metadata ?? null,
      expiration: options.expiration || (options.expirationTtl ? Math.floor(Date.now() / 1000) + options.expirationTtl : null) });
  }

  async delete(key) {
    await this.write(key, { value: null, deleted: true, metadata: null, expiration: null });
  }

  async write(key, value) {
    await this.storage.transaction(async (txn) => {
      const previous = await txn.get(`v:${key}`);
      const record = { ...value, revision: (previous?.revision || 0) + 1 };
      await txn.put({ [`v:${key}`]: record, [`o:${key}`]: record });
    });
    await this.scheduleAlarm();
  }

  async scheduleAlarm() {
    const due = Date.now() + 1500;
    const alarm = await this.storage.getAlarm();
    if (!alarm || alarm > due) await this.storage.setAlarm(due);
  }

  async importPrefix(prefix) {
    const marker = `i:${prefix}`;
    let progress = await this.storage.get(marker);
    if (progress?.done || (prefix && (await this.storage.get("i:"))?.done)) return;
    let cursor = progress?.cursor;
    do {
      const page = await this.legacy.list({ prefix, cursor, limit: 100 });
      const names = page.keys.map((key) => key.name);
      const values = names.length ? await this.legacy.get(names, "text") : new Map();
      await this.storage.transaction(async (txn) => {
        const current = names.length ? await txn.get(names.map((name) => `v:${name}`)) : new Map();
        const entries = {};
        for (const info of page.keys) {
          if (current.has(`v:${info.name}`)) continue;
          const value = values.get(info.name) ?? null;
          entries[`v:${info.name}`] = { value, deleted: value === null, metadata: info.metadata ?? null, expiration: info.expiration || null, revision: 0 };
        }
        if (Object.keys(entries).length) await txn.put(entries);
        await txn.put(marker, { done: !!page.list_complete, cursor: page.cursor });
      });
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  }

  async list({ prefix = "", cursor, limit = 1000 } = {}) {
    await this.importPrefix(prefix);
    const options = { prefix: `v:${prefix}`, limit: Math.min(1000, Math.max(1, limit)) };
    if (cursor) options.startAfter = decodeURIComponent(cursor);
    const records = await this.storage.list(options);
    const keys = [];
    for (const [name, record] of records) if (this.active(record)) keys.push({ name: name.slice(2), metadata: record.metadata, expiration: record.expiration || undefined });
    const complete = records.size < options.limit;
    return { keys, list_complete: complete, cursor: complete ? "" : encodeURIComponent([...records.keys()].at(-1)) };
  }

  async flushMirrors() {
    const marker = "d:mirror_cursor", cursor = await this.storage.get(marker);
    let jobs = await this.storage.list({ prefix: "o:", limit: 40, ...(cursor ? { startAfter: cursor } : {}) });
    if (!jobs.size && cursor) jobs = await this.storage.list({ prefix: "o:", limit: 40 });
    let failedCount = 0, lastError = "";
    for (const [jobKey, record] of jobs) {
      const key = jobKey.slice(2);
      const last = Number(await this.storage.get(`m:${key}`)) || 0;
      if (Date.now() - last < 1200) continue;
      try {
        if (!this.active(record) || (record.expiration && record.expiration - Date.now() / 1000 < 60)) await this.legacy.delete(key);
        else {
          const options = {};
          if (record.expiration) options.expiration = record.expiration;
          if (record.metadata !== null) options.metadata = record.metadata;
          await this.legacy.put(key, record.value, options);
        }
        await this.storage.transaction(async (txn) => {
          await txn.put(`m:${key}`, Date.now());
          const newest = await txn.get(jobKey);
          if (newest?.revision === record.revision) await txn.delete(jobKey);
        });
      } catch (error) {
        failedCount++;
        lastError = String(error?.message || error);
        // 下次 alarm 重试；即时授权已在协调器持久化，不依赖 KV 同步成功。
      }
    }
    if (jobs.size === 40) await this.storage.put(marker, [...jobs.keys()].at(-1));
    else await this.storage.delete(marker);
    return { failedCount, lastError };
  }

  async sweepExpired() {
    for (const prefix of ["u:", "s:", "v:"]) {
      const marker = `gc:${prefix}`;
      const after = await this.storage.get(marker);
      const records = await this.storage.list({ prefix, limit: 200, ...(after ? { startAfter: after } : {}) });
      for (const [key, value] of records) {
        if (prefix === "u:" && value <= Date.now()) await this.storage.delete(key);
        if (prefix === "s:" && (value.updatedAt || value.createdAt) + 24 * 60 * 60 * 1000 <= Date.now()) await this.storage.delete(key);
        if (prefix === "v:" && !this.active(value) && await this.isImported(key.slice(2))) {
          await this.storage.transaction(async (txn) => {
            const current = await txn.get(key);
            if (!this.active(current) && !(await txn.get(`o:${key.slice(2)}`))) await txn.delete([key, `m:${key.slice(2)}`]);
          });
        }
      }
      if (records.size === 200) await this.storage.put(marker, [...records.keys()].at(-1));
      else await this.storage.delete(marker);
    }
  }
}
