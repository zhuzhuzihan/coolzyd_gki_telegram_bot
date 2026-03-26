/**
 * Telegram Bot for GKI Kernel Download
 * Deployed on Cloudflare Worker
 */

interface Env {
  BOT_TOKEN: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    message_thread_id?: number;
    is_topic_message?: boolean;
    from?: {
      id: number;
      first_name: string;
      username?: string;
    };
    sender_chat?: {
      id: number;
      title: string;
      type: string;
    };
    chat: {
      id: number;
      type: string;
    };
    text?: string;
  };
  channel_post?: {
    message_id: number;
    message_thread_id?: number;
    chat: {
      id: number;
      type: string;
    };
    text?: string;
  };
}

interface GitHubAsset {
  name: string;
  browser_download_url: string;
}

interface GitHubRelease {
  tag_name: string;
  name: string;
  assets: GitHubAsset[];
}

// Extract kernel version from filename
// Example: android12-5.10.101-2022-04-AnyKernel3.zip -> 5.10.101
function extractKernelVersion(filename: string): string | null {
  const match = filename.match(/android\d+-(\d+\.\d+\.\d+)-\d+-\d+-AnyKernel3\.zip/);
  return match ? match[1] : null;
}

// Check if file is AnyKernel3
function isAnyKernel3(filename: string): boolean {
  return filename.includes('AnyKernel3') && filename.endsWith('.zip');
}

// Fetch latest release from GitHub
async function getLatestRelease(): Promise<GitHubRelease | null> {
  const url = 'https://api.github.com/repos/coolzyd9107/GKI_KernelSU_SUSFS/releases/latest';

  const response = await fetch(url, {
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Telegram-GKI-Bot'
    }
  });

  if (!response.ok) {
    console.error(`GitHub API error: ${response.status}`);
    return null;
  }

  return await response.json() as GitHubRelease;
}

// Find matching AnyKernel3 file by kernel version
function findMatchingAsset(assets: GitHubAsset[], kernelVersion: string): GitHubAsset | null {
  for (const asset of assets) {
    if (isAnyKernel3(asset.name)) {
      const version = extractKernelVersion(asset.name);
      if (version === kernelVersion) {
        return asset;
      }
    }
  }
  return null;
}

// Get all available kernel versions from AnyKernel3 files
function getAvailableVersions(assets: GitHubAsset[]): string[] {
  const versions: string[] = [];
  for (const asset of assets) {
    if (isAnyKernel3(asset.name)) {
      const version = extractKernelVersion(asset.name);
      if (version) {
        versions.push(version);
      }
    }
  }
  return versions;
}

// Send message to Telegram with optional reply and thread support
async function sendMessage(
  botToken: string,
  chatId: number,
  text: string,
  parseMode: string = 'Markdown',
  replyToMessageId?: number,
  messageThreadId?: number
): Promise<void> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  const body: Record<string, unknown> = {
    chat_id: chatId,
    text: text,
    parse_mode: parseMode,
    disable_web_page_preview: false
  };

  if (replyToMessageId) {
    body.reply_to_message_id = replyToMessageId;
  }

  // Support for Forum/Topic groups
  if (messageThreadId) {
    body.message_thread_id = messageThreadId;
  }

  await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body)
  });
}

// Handle /get_gki command
async function handleGetGKI(
  botToken: string,
  chatId: number,
  kernelVersion: string | null,
  replyToMessageId?: number,
  messageThreadId?: number
): Promise<void> {
  if (!kernelVersion) {
    await sendMessage(
      botToken,
      chatId,
      'Please specify a kernel version.\nUsage: `/get_gki <version>`\nExample: `/get_gki 5.10.101`',
      'Markdown',
      replyToMessageId,
      messageThreadId
    );
    return;
  }

  try {
    const release = await getLatestRelease();

    if (!release) {
      await sendMessage(
        botToken,
        chatId,
        '❌ Failed to fetch release information from GitHub. Please try again later.',
        'HTML',
        replyToMessageId,
        messageThreadId
      );
      return;
    }

    const asset = findMatchingAsset(release.assets, kernelVersion);

    if (asset) {
      const message = `Here's AnyKernel3 with the <b>${kernelVersion}</b> kernel that fits your needs:\n\nDownload: <a href="${asset.browser_download_url}">Click Here</a>`;
      await sendMessage(botToken, chatId, message, 'HTML', replyToMessageId, messageThreadId);
    } else {
      const availableVersions = getAvailableVersions(release.assets);

      if (availableVersions.length === 0) {
        await sendMessage(
          botToken,
          chatId,
          '❌ No AnyKernel3 files found in the latest release.',
          'HTML',
          replyToMessageId,
          messageThreadId
        );
      } else {
        const versionsList = availableVersions.map(v => `• <code>${v}</code>`).join('\n');
        await sendMessage(
          botToken,
          chatId,
          `❌ Kernel version <b>${kernelVersion}</b> not found.\n\nAvailable versions:\n${versionsList}`,
          'HTML',
          replyToMessageId,
          messageThreadId
        );
      }
    }
  } catch (error) {
    console.error('Error handling /get_gki:', error);
    await sendMessage(
      botToken,
      chatId,
      '❌ An error occurred while processing your request. Please try again later.',
      'HTML',
      replyToMessageId,
      messageThreadId
    );
  }
}

// Handle /start command
async function handleStart(botToken: string, chatId: number, replyToMessageId?: number, messageThreadId?: number): Promise<void> {
  const message = `<b>GKI Kernel Download Bot</b>\n\nThis bot helps you download GKI kernels with ReSukiSU and SUSFS.\n\nCommands:\n• /get_gki &lt;version&gt; - Get AnyKernel3 for specific kernel version\n• /list - List all available kernel versions\n• /help - Show this help message`;
  await sendMessage(botToken, chatId, message, 'HTML', replyToMessageId, messageThreadId);
}

// Handle /help command
async function handleHelp(botToken: string, chatId: number, replyToMessageId?: number, messageThreadId?: number): Promise<void> {
  await handleStart(botToken, chatId, replyToMessageId, messageThreadId);
}

// Handle /list command
async function handleList(botToken: string, chatId: number, replyToMessageId?: number, messageThreadId?: number): Promise<void> {
  try {
    const release = await getLatestRelease();

    if (!release) {
      await sendMessage(
        botToken,
        chatId,
        '❌ Failed to fetch release information from GitHub. Please try again later.',
        'HTML',
        replyToMessageId,
        messageThreadId
      );
      return;
    }

    const availableVersions = getAvailableVersions(release.assets);

    if (availableVersions.length === 0) {
      await sendMessage(
        botToken,
        chatId,
        '❌ No AnyKernel3 files found in the latest release.',
        'HTML',
        replyToMessageId,
        messageThreadId
      );
    } else {
      const versionsList = availableVersions.map(v => `• <code>${v}</code>`).join('\n');
      await sendMessage(
        botToken,
        chatId,
        `<b>Available Kernel Versions:</b>\n\n${versionsList}\n\nUse <code>/get_gki &lt;version&gt;</code> to download.`,
        'HTML',
        replyToMessageId,
        messageThreadId
      );
    }
  } catch (error) {
    console.error('Error handling /list:', error);
    await sendMessage(
      botToken,
      chatId,
      '❌ An error occurred while processing your request. Please try again later.',
      'HTML',
      replyToMessageId,
      messageThreadId
    );
  }
}

// Parse command and arguments from message text
// Handles both /command and /command@bot_username formats
function parseCommand(text: string): { command: string; args: string } {
  const parts = text.trim().split(/\s+/);
  let command = parts[0]?.toLowerCase() || '';

  // Remove @bot_username suffix for group commands
  const atIndex = command.indexOf('@');
  if (atIndex !== -1) {
    command = command.substring(0, atIndex);
  }

  const args = parts.slice(1).join(' ');
  return { command, args };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Handle webhook from Telegram
    if (request.method === 'POST') {
      try {
        const update: TelegramUpdate = await request.json();

        // Handle regular messages
        if (update.message && update.message.text) {
          const { command, args } = parseCommand(update.message.text);
          const chatId = update.message.chat.id;
          const messageId = update.message.message_id;
          const threadId = update.message.message_thread_id;

          switch (command) {
            case '/start':
              await handleStart(env.BOT_TOKEN, chatId, messageId, threadId);
              break;
            case '/help':
              await handleHelp(env.BOT_TOKEN, chatId, messageId, threadId);
              break;
            case '/get_gki':
              await handleGetGKI(env.BOT_TOKEN, chatId, args || null, messageId, threadId);
              break;
            case '/list':
              await handleList(env.BOT_TOKEN, chatId, messageId, threadId);
              break;
            default:
              // Unknown command, ignore
              break;
          }
        }

        // Handle channel posts (for channels where bot is admin)
        if (update.channel_post && update.channel_post.text) {
          const { command, args } = parseCommand(update.channel_post.text);
          const chatId = update.channel_post.chat.id;
          const messageId = update.channel_post.message_id;
          const threadId = update.channel_post.message_thread_id;

          switch (command) {
            case '/start':
              await handleStart(env.BOT_TOKEN, chatId, messageId, threadId);
              break;
            case '/help':
              await handleHelp(env.BOT_TOKEN, chatId, messageId, threadId);
              break;
            case '/get_gki':
              await handleGetGKI(env.BOT_TOKEN, chatId, args || null, messageId, threadId);
              break;
            case '/list':
              await handleList(env.BOT_TOKEN, chatId, messageId, threadId);
              break;
            default:
              break;
          }
        }

        return new Response('OK', { status: 200 });
      } catch (error) {
        console.error('Error processing update:', error);
        return new Response('Error', { status: 500 });
      }
    }

    // Health check endpoint
    if (request.method === 'GET') {
      const url = new URL(request.url);

      // Return bot info for root path
      if (url.pathname === '/') {
        return new Response(JSON.stringify({
          status: 'ok',
          bot: 'GKI Kernel Download Bot',
          version: '1.0.0'
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Set webhook endpoint
      if (url.pathname === '/setWebhook') {
        const webhookUrl = `${url.origin}/webhook`;
        const telegramUrl = `https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook`;

        const response = await fetch(telegramUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: webhookUrl })
        });

        const result = await response.json();
        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Set commands endpoint
      if (url.pathname === '/setCommands') {
        const telegramUrl = `https://api.telegram.org/bot${env.BOT_TOKEN}/setMyCommands`;
        const commands = [
          { command: 'start', description: 'Start the bot' },
          { command: 'help', description: 'Show help message' },
          { command: 'get_gki', description: 'Get GKI kernel by version' },
          { command: 'list', description: 'List available kernel versions' }
        ];

        const response = await fetch(telegramUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ commands })
        });

        const result = await response.json();
        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      return new Response('Not Found', { status: 404 });
    }

    return new Response('Method Not Allowed', { status: 405 });
  }
};
