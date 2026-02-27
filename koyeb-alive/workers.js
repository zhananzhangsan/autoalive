/**
 * Koyeb Keep-Alive Worker (精简版)
 *
 * 环境变量 (Environment Variables):
 * - KOYEB_LOGIN:   (必填) 账户信息，格式: email1:PAT1\nemail2:PAT2（一行一个）
 * - TG_BOT_TOKEN:  (可选) Telegram Bot Token
 * - TG_CHAT_ID:    (可选) Telegram Chat ID
 *
 */

const CONFIG = {
  REQUEST_TIMEOUT: 30000,
  KOYEB_PROFILE_URL: 'https://app.koyeb.com/v1/account/profile',
  ACCOUNT_DELAY: 3000,
};

// ==================== 时间工具 ====================

function bjTime(date = new Date()) {
  return date.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
}

// ==================== 入口 ====================

export default {
  async fetch(request, env) {
    const result = await keepAlive(env, 'HTTP Request');
    return new Response(JSON.stringify(result, null, 2), {
      headers: { 'Content-Type': 'application/json;charset=UTF-8' },
    });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(keepAlive(env, 'Cron Scheduled'));
  },
};

// ==================== 账户加载 ====================

function loadAccounts(env) {
  const raw = (env.KOYEB_LOGIN || '').trim();
  if (!raw) return [];

  const lines = raw.split(/[\n,]/).map(l => l.trim()).filter(Boolean);
  const accounts = [];

  for (const line of lines) {
    if (!line.includes(':')) continue;
    const idx = line.indexOf(':');
    const email = line.substring(0, idx).trim();
    const pat = line.substring(idx + 1).trim();
    if (email && pat) accounts.push({ email, pat });
  }
  return accounts;
}

// ==================== 带超时 fetch ====================

async function fetchWithTimeout(url, options = {}, timeout = CONFIG.REQUEST_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ==================== 账户验证 ====================

async function verifyAccount(email, pat) {
  if (!email || !pat) {
    return { success: false, message: '邮箱或 PAT 为空' };
  }

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${pat}`,
    'User-Agent': 'KoyebKeepAlive/2.0-CFWorker',
  };

  try {
    const start = Date.now();
    const response = await fetchWithTimeout(CONFIG.KOYEB_PROFILE_URL, { method: 'GET', headers });
    const duration = Date.now() - start;

    if (response.status === 401 || response.status === 403) {
      return { success: false, message: '验证失败：PAT 无效或已过期', duration };
    }

    if (!response.ok) {
      let errMsg = `API错误 (状态码 ${response.status})`;
      try {
        const errData = await response.json();
        errMsg += `: ${errData.error || response.statusText}`;
      } catch {
        errMsg += `: ${response.statusText}`;
      }
      return { success: false, message: errMsg, duration };
    }

    const profileData = await response.json();
    const user = profileData.user || {};
    const returnedEmail = (user.email || '').toLowerCase();
    const flags = user.flags || [];
    const emailValidated = !!user.email_validated;

    if (returnedEmail !== email.toLowerCase()) {
      return { success: false, message: `API返回邮箱(${returnedEmail})与提供邮箱不匹配`, duration };
    }

    const isActive = flags.includes('ACTIVE');

    if (isActive && emailValidated) {
      return { success: true, message: '活跃且邮箱已验证', duration };
    } else if (!isActive) {
      return { success: false, message: `非活跃 (Flags: ${flags.join(', ') || '无'})`, duration };
    } else if (!emailValidated) {
      return { success: false, message: '邮箱未验证', duration };
    } else {
      return { success: false, message: `未知状态`, duration };
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      return { success: false, message: '请求超时' };
    }
    return { success: false, message: `网络异常: ${err.message}` };
  }
}

// ==================== 核心保活 ====================

async function keepAlive(env, source = 'Manual') {
  const ts = bjTime();

  const accounts = loadAccounts(env);
  if (accounts.length === 0) {
    const msg = `❌ KOYEB_LOGIN 未配置或无有效账户`;
    console.log(msg);
    await sendTelegram(env, `🤖 *Koyeb 状态报告*\n⏰ ${ts}\n${msg}`);
    return { success: false, message: msg };
  }

  const total = accounts.length;
  let successCount = 0;
  const resultLines = [];

  for (let i = 0; i < accounts.length; i++) {
    const { email, pat } = accounts[i];

    if (i > 0) await sleep(CONFIG.ACCOUNT_DELAY);

    const result = await verifyAccount(email, pat);
    const dur = result.duration ? ` (${result.duration}ms)` : '';

    if (result.success) {
      successCount++;
      console.log(`✅ [${i + 1}/${total}] ${email} - ${result.message}${dur}`);
      resultLines.push(`账户: \`${email}\`\n状态: ✅ ${result.message}\n`);
    } else {
      console.log(`❌ [${i + 1}/${total}] ${email} - ${result.message}${dur}`);
      resultLines.push(`账户: \`${email}\`\n状态: ❌ ${result.message}\n`);
    }
  }

  const failCount = total - successCount;

  const tgMessage =
    `🤖 *Koyeb 账户状态报告* 🤖\n` +
    `=====================\n` +
    `⏰ 日期: ${ts}\n` +
    `📊 总计: ${total} 个账户\n` +
    `✅ 成功: ${successCount} 个 | ❌ 失败: ${failCount} 个\n` +
    `---------------------------\n` +
    resultLines.join('');

  await sendTelegram(env, tgMessage);

  return { success: failCount === 0, total, successCount, failCount };
}

// ==================== Telegram ====================

async function sendTelegram(env, message) {
  const botToken = env.TG_BOT_TOKEN;
  const chatId = env.TG_CHAT_ID;
  if (!botToken || !chatId) return;

  try {
    const res = await fetchWithTimeout(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'Markdown' }),
      }
    );
    if (!res.ok) console.error(`Telegram 发送失败: ${res.status}`);
  } catch (e) {
    console.error(`Telegram 异常: ${e.message}`);
  }
}

// ==================== 工具 ====================

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
