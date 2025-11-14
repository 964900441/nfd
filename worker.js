// ========= 全局变量，占位，真正的值在 fetch 里从 env 注入 =========
let TOKEN, SECRET, ADMIN_UID, VERIFY_CODE_SHOW, VERIFY_CODE_REAL, nfd;

// 不依赖 env 的常量
const WEBHOOK = '/endpoint';             // Webhook 路径
const NOTIFY_INTERVAL = 3600 * 1000;     // 防骗提示间隔（1 小时）

const fraudDb = 'https://raw.githubusercontent.com/LloydAsp/nfd/main/data/fraud.db';
const notificationUrl = 'https://raw.githubusercontent.com/LloydAsp/nfd/main/data/notification.txt';
const startMsgUrl = 'https://raw.githubusercontent.com/LloydAsp/nfd/main/data/startMessage.md';

const enable_notification = true;

// ========= Cloudflare Modules 入口 =========
export default {
  async fetch(request, env, ctx) {
    // 从环境变量中读取配置
    TOKEN = env.ENV_BOT_TOKEN;
    SECRET = env.ENV_BOT_SECRET;
    ADMIN_UID = env.ENV_ADMIN_UID?.toString();

    // 人机验证相关环境变量
    VERIFY_CODE_SHOW = env.ENV_VERIFY_SHOW || '我不是广告';
    VERIFY_CODE_REAL = env.ENV_VERIFY_REAL || VERIFY_CODE_SHOW;

    // KV 命名空间
    nfd = env.nfd;

    return handleFetch(request, ctx);
  }
};

// ========= 路由分发 =========
async function handleFetch(request, ctx) {
  const url = new URL(request.url);

  if (url.pathname === WEBHOOK) {
    return handleWebhook(request, ctx);
  } else if (url.pathname === '/registerWebhook') {
    return registerWebhook(request);
  } else if (url.pathname === '/unRegisterWebhook') {
    return unRegisterWebhook(request);
  } else {
    return new Response('No handler for this request');
  }
}

// ========= Telegram API 封装 =========
function apiUrl(methodName, params = null) {
  let query = '';
  if (params) {
    query = '?' + new URLSearchParams(params).toString();
  }
  return `https://api.telegram.org/bot${TOKEN}/${methodName}${query}`;
}

function requestTelegram(methodName, body, params = null) {
  return fetch(apiUrl(methodName, params), body).then(r => r.json());
}

function makeReqBody(body) {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  };
}

function sendMessage(msg = {}) {
  return requestTelegram('sendMessage', makeReqBody(msg));
}

function copyMessage(msg = {}) {
  return requestTelegram('copyMessage', makeReqBody(msg));
}

function forwardMessage(msg) {
  return requestTelegram('forwardMessage', makeReqBody(msg));
}

// ========= Webhook 处理 =========
async function handleWebhook(request, ctx) {
  // 校验 Secret，防止伪造请求
  if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== SECRET) {
    return new Response('Unauthorized', { status: 403 });
  }

  const update = await request.json();
  ctx.waitUntil(onUpdate(update));

  return new Response('Ok');
}

async function onUpdate(update) {
  if ('message' in update) {
    await onMessage(update.message);
  }
}

// ========= 消息处理 =========
async function onMessage(message) {
  // /start 指令：发送说明文案
  if (message.text === '/start') {
    let startMsg = await fetch(startMsgUrl).then(r => r.text());
    return sendMessage({
      chat_id: message.chat.id,
      text: startMsg,
    });
  }

  // 管理员自己的消息
  if (message.chat.id.toString() === ADMIN_UID) {
    if (!message?.reply_to_message?.chat) {
      return sendMessage({
        chat_id: ADMIN_UID,
        text: '使用方法：回复转发的消息并发送回复内容，或发送 `/block`、`/unblock`、`/checkblock` 等指令'
      });
    }

    if (/^\/block$/.exec(message.text)) {
      return handleBlock(message);
    }
    if (/^\/unblock$/.exec(message.text)) {
      return handleUnBlock(message);
    }
    if (/^\/checkblock$/.exec(message.text)) {
      return checkBlock(message);
    }

    // 管理员正常回复 → 复制消息给访客
    let guestChantId = await nfd.get(
      'msg-map-' + message?.reply_to_message.message_id,
      { type: "json" }
    );
    return copyMessage({
      chat_id: guestChantId,
      from_chat_id: message.chat.id,
      message_id: message.message_id,
    });
  }

  // 普通用户（访客）消息
  return handleGuestMessage(message);
}

// ========= 人机验证相关 =========
async function isVerified(chatId) {
  return await nfd.get('verified-' + chatId, { type: "json" });
}

async function setVerified(chatId) {
  return await nfd.put('verified-' + chatId, true);
}

/**
 * 未通过人机验证的用户进入这里
 * - 提示内容用 VERIFY_CODE_SHOW
 * - 真正校验用 VERIFY_CODE_REAL
 */
async function handleVerify(message) {
  let chatId = message.chat.id;
  let text = (message.text || '').trim();

  // 只要内容不满足“真正的校验条件”，就一直提示
  if (text !== VERIFY_CODE_REAL) {
    return sendMessage({
      chat_id: chatId,
      text: `为防止广告骚扰，请回复下面的内容完成验证：\n\n${VERIFY_CODE_SHOW}\n\n只需把这句话原样发给我即可。`
    });
  }

  // 满足真正验证码 → 标记通过验证
  await setVerified(chatId);

  return sendMessage({
    chat_id: chatId,
    text: '验证成功，您现在可以正常与我聊天了。请重新发送刚才的内容。'
  });
}

// ========= 访客消息处理 =========
async function handleGuestMessage(message) {
  let chatId = message.chat.id;
  let isblocked = await nfd.get('isblocked-' + chatId, { type: "json" });

  // 被管理员屏蔽
  if (isblocked) {
    return sendMessage({
      chat_id: chatId,
      text: 'Your are blocked'
    });
  }

  // 未通过人机验证 → 先验证，不转发给管理员
  if (!await isVerified(chatId)) {
    return handleVerify(message);
  }

  // 已验证用户 → 正常转发给管理员
  let forwardReq = await forwardMessage({
    chat_id: ADMIN_UID,
    from_chat_id: message.chat.id,
    message_id: message.message_id
  });
  console.log(JSON.stringify(forwardReq));
  if (forwardReq.ok) {
    await nfd.put('msg-map-' + forwardReq.result.message_id, chatId);
  }
  return handleNotify(message);
}

// ========= 防骗提醒 / 黑名单 =========
async function handleNotify(message) {
  let chatId = message.chat.id;

  if (await isFraud(chatId)) {
    return sendMessage({
      chat_id: ADMIN_UID,
      text: `检测到骗子，UID${chatId}`
    });
  }

  if (enable_notification) {
    let lastMsgTime = await nfd.get('lastmsg-' + chatId, { type: "json" });
    if (!lastMsgTime || Date.now() - lastMsgTime > NOTIFY_INTERVAL) {
      await nfd.put('lastmsg-' + chatId, Date.now());
      return sendMessage({
        chat_id: ADMIN_UID,
        text: await fetch(notificationUrl).then(r => r.text())
      });
    }
  }
}

// ========= 屏蔽相关命令 =========
async function handleBlock(message) {
  let guestChantId = await nfd.get(
    'msg-map-' + message.reply_to_message.message_id,
    { type: "json" }
  );

  if (guestChantId && guestChantId.toString() === ADMIN_UID.toString()) {
    return sendMessage({
      chat_id: ADMIN_UID,
      text: '不能屏蔽自己'
    });
  }
  await nfd.put('isblocked-' + guestChantId, true);

  return sendMessage({
    chat_id: ADMIN_UID,
    text: `UID:${guestChantId}屏蔽成功`,
  });
}

async function handleUnBlock(message) {
  let guestChantId = await nfd.get(
    'msg-map-' + message.reply_to_message.message_id,
    { type: "json" }
  );

  await nfd.put('isblocked-' + guestChantId, false);

  return sendMessage({
    chat_id: ADMIN_UID,
    text: `UID:${guestChantId}解除屏蔽成功`,
  });
}

async function checkBlock(message) {
  let guestChantId = await nfd.get(
    'msg-map-' + message.reply_to_message.message_id,
    { type: "json" }
  );
  let blocked = await nfd.get('isblocked-' + guestChantId, { type: "json" });

  return sendMessage({
    chat_id: ADMIN_UID,
    text: `UID:${guestChantId}` + (blocked ? '被屏蔽' : '没有被屏蔽')
  });
}

// ========= Webhook 注册 / 注销 =========
async function registerWebhook(request) {
  const url = new URL(request.url);
  const webhookUrl = `${url.protocol}//${url.hostname}${WEBHOOK}`;
  const r = await (await fetch(
    apiUrl('setWebhook', { url: webhookUrl, secret_token: SECRET })
  )).json();
  return new Response(('ok' in r && r.ok) ? 'Ok' : JSON.stringify(r, null, 2));
}

async function unRegisterWebhook(request) {
  const r = await (await fetch(
    apiUrl('setWebhook', { url: '' })
  )).json();
  return new Response(('ok' in r && r.ok) ? 'Ok' : JSON.stringify(r, null, 2));
}

// ========= 诈骗名单检查 =========
async function isFraud(id) {
  id = id.toString();
  let db = await fetch(fraudDb).then(r => r.text());
  let arr = db.split('\n').filter(v => v);
  let flag = arr.includes(id);
  return flag;
}
