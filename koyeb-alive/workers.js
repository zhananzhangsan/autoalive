/**
 * Koyeb 账户状态检查器
 * 功能：验证 Koyeb 账户状态并通过 Telegram 发送报告
 */

// --- 常量定义 ---
const KOYEB_PROFILE_URL = "https://app.koyeb.com/v1/account/profile";
const REQUEST_TIMEOUT = 30000; // 请求超时，单位：毫秒

// --- 工具函数 ---

/**
 * 获取北京时间格式化字符串
 */
function getBeijingTime() {
    const now = new Date();
    return now.toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).replace(/\//g, '-');
}

/**
 * 日志函数
 */
const logger = {
    info: (msg) => console.log(`${getBeijingTime()} - INFO - ${msg}`),
    warn: (msg) => console.warn(`${getBeijingTime()} - WARN - ${msg}`),
    error: (msg) => console.error(`${getBeijingTime()} - ERROR - ${msg}`)
};

/**
 * 延时函数
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 带超时的 fetch 请求
 */
async function fetchWithTimeout(url, options, timeout = REQUEST_TIMEOUT) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        return response;
    } finally {
        clearTimeout(timeoutId);
    }
}

// --- 账户加载/验证函数 ---

/**
 * 从环境变量 KOYEB_LOGIN 加载账户信息
 * 格式: "email1:PAT1\nemail2:PAT2"
 */
function validateAndLoadAccounts() {
    const koyebLoginEnv = process.env.KOYEB_LOGIN;

    if (!koyebLoginEnv) {
        logger.error("❌ KOYEB_LOGIN 变量未配置，脚本无法继续执行");
        throw new Error("必须配置 KOYEB_LOGIN 环境变量");
    }

    const accounts = [];
    const lines = koyebLoginEnv.trim().split('\n');

    for (const rawLine of lines) {
        const line = rawLine.trim();

        if (!line || !line.includes(':')) {
            logger.warn(`⚠️ 跳过无效或空行: ${line}`);
            continue;
        }

        const colonIndex = line.indexOf(':');
        const email = line.substring(0, colonIndex).trim();
        const pat = line.substring(colonIndex + 1).trim();

        if (email && pat) {
            accounts.push({ email, pat });
        } else {
            logger.error(`⚠️ KOYEB_LOGIN 行格式错误，应为 email:PAT -> ${line}`);
        }
    }

    if (accounts.length === 0) {
        throw new Error("KOYEB_LOGIN 环境变量未包含任何有效账户信息");
    }

    return accounts;
}

// --- Telegram 发送函数 ---

/**
 * 发送 Telegram 消息
 */
async function sendTgMessage(message) {
    const botToken = process.env.TG_BOT_TOKEN;
    const chatId = process.env.TG_CHAT_ID;

    if (!botToken || !chatId) {
        logger.warn("⚠️ TG_BOT_TOKEN 或 TG_CHAT_ID 未设置，跳过发送 Telegram 消息。");
        return null;
    }

    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const payload = {
        chat_id: chatId,
        text: message,
        parse_mode: "Markdown"
    };

    try {
        const response = await fetchWithTimeout(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorText = await response.text();
            logger.error(`❌ 发送 Telegram 消息时发生HTTP错误: ${response.status}`);
            logger.error(`❌ 响应内容: ${errorText}`);
            return null;
        }

        return await response.json();
    } catch (error) {
        if (error.name === 'AbortError') {
            logger.error("❌ 发送 Telegram 消息超时");
        } else {
            logger.error(`❌ 发送 Telegram 消息失败: ${error.message}`);
        }
        return null;
    }
}

// --- 账户验证函数 ---

/**
 * 使用 PAT 调用 /v1/account/profile 端点，并验证账户状态
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function verifyKoyebAccountStatus(email, pat) {
    if (!email || !pat) {
        return { success: false, message: "邮箱或个人访问令牌 (PAT) 为空" };
    }

    const headers = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${pat}`,
        "User-Agent": "KoyebAccountStatusChecker/1.0"
    };

    try {
        const response = await fetchWithTimeout(KOYEB_PROFILE_URL, {
            method: 'GET',
            headers
        });

        // 检查 HTTP 状态码
        if (response.status === 401 || response.status === 403) {
            return { success: false, message: "验证失败：PAT 无效或已过期。" };
        }

        if (!response.ok) {
            let errorMessage;
            try {
                const errorData = await response.json();
                errorMessage = errorData.error || response.statusText;
            } catch {
                errorMessage = await response.text();
            }
            return {
                success: false,
                message: `原因: API错误 (状态码 ${response.status}): ${errorMessage}`
            };
        }

        // 解析并验证返回的 JSON 数据
        const profileData = await response.json();
        const userInfo = profileData.user || {};
        const returnedEmail = userInfo.email || '';
        const flags = userInfo.flags || [];
        const emailValidated = userInfo.email_validated || false;

        // 严格验证逻辑
        if (returnedEmail.toLowerCase() !== email.toLowerCase()) {
            return {
                success: false,
                message: `验证失败：API返回邮箱(${returnedEmail})与提供邮箱不匹配。`
            };
        }

        const isActive = flags.includes("ACTIVE");

        if (isActive && emailValidated) {
            return { success: true, message: "活跃且邮箱已验证" };
        } else if (!isActive) {
            return {
                success: false,
                message: `原因: 非活跃 (Flags: ${flags.join(', ')})`
            };
        } else if (!emailValidated) {
            return { success: false, message: "原因: 邮箱未验证" };
        } else {
            return {
                success: false,
                message: `原因: 未知账户: ${JSON.stringify(userInfo)}`
            };
        }

    } catch (error) {
        if (error.name === 'AbortError') {
            return { success: false, message: "原因: 请求超时" };
        }
        return { success: false, message: `原因: 网络请求异常: ${error.message}` };
    }
}

// --- 主函数 ---

async function main() {
    try {
        const koyebAccounts = validateAndLoadAccounts();

        const results = [];
        const currentTime = getBeijingTime();
        const totalAccounts = koyebAccounts.length;
        let successCount = 0;

        for (let index = 0; index < koyebAccounts.length; index++) {
            const account = koyebAccounts[index];
            const email = (account.email || '').trim();
            const pat = account.pat || '';

            if (!email || !pat) {
                logger.warn(`⚠️ 第 ${index + 1}/${totalAccounts} 个账户信息不完整，已跳过`);
                results.push(`账户: 未提供邮箱\n状态: ❌ 信息不完整\n`);
                continue;
            }

            logger.info(`🚀 正在处理第 ${index + 1}/${totalAccounts} 个账户: ${email}`);
            await sleep(10000); // 等待10秒

            try {
                const { success, message } = await verifyKoyebAccountStatus(email, pat);

                let statusLine;
                if (success) {
                    statusLine = `状态: ✅ ${message}`;
                    successCount++;
                } else {
                    statusLine = `状态: ❌ 验证失败\n  ${message}`;
                }

                results.push(`账户: \`${email}\`\n${statusLine}\n`);
            } catch (error) {
                logger.error(`❌ 处理账户 ${email} 时发生未知异常: ${error.message}`);
                results.push(`账户: \`${email}\`\n状态: ❌ 验证失败\n  执行时发生未知异常 - ${error.message}\n`);
            }
        }

        // 生成报告
        const summary = `📊 总计: ${totalAccounts} 个账户\n✅ 成功: ${successCount} 个 | ❌ 失败: ${totalAccounts - successCount} 个`;
        const reportBody = results.join('');
        const tgMessage = `🤖 *Koyeb 账户状态报告* 🤖
=====================
⏰ 日期: ${currentTime}
${summary}
---------------------------
${reportBody}`;

        logger.info("📊 --- 报告预览 ---\n" + tgMessage);
        await sendTgMessage(tgMessage);
        logger.info("🎉 脚本执行完毕。");

        // 如果全部失败则退出
        if (successCount === 0 && totalAccounts > 0) {
            logger.error("❌ 所有账户验证失败，脚本将以非零状态码退出");
            process.exit(1);
        }

    } catch (error) {
        const errorMessage = `❌ 程序初始化失败: ${error.message}`;
        logger.error(errorMessage);
        await sendTgMessage(errorMessage);
        process.exit(1);
    }
}

// 运行主函数
main();
