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

// Kernel version info interface
interface KernelVersion {
  version: string;       // e.g., "5.10.101" or "6.1.X-lts"
  isLts: boolean;        // true for LTS versions
  majorMinor: string;    // e.g., "5.10" or "6.1"
}

// Extract kernel version from filename
// Supports multiple formats based on actual GitHub release files:
// - Standard: android12-5.10.101-2022-04-AnyKernel3.zip -> {version: "5.10.101", isLts: false}
// - LTS: android14-6.1.X-lts-AnyKernel3.zip -> {version: "6.1.X-lts", isLts: true}
// - LTS: android15-6.6.X-lts-AnyKernel3.zip -> {version: "6.6.X-lts", isLts: true}
// - LTS: android16-6.12.X-lts-AnyKernel3.zip -> {version: "6.12.X-lts", isLts: true}
function extractKernelVersion(filename: string): KernelVersion | null {
  // Pattern for LTS format: androidXX-X.X.X-lts-AnyKernel3.zip
  // Example: android14-6.1.X-lts-AnyKernel3.zip
  let match = filename.match(/android\d+-(\d+\.\d+)\.X-lts-AnyKernel3\.zip/i);
  if (match) {
    return {
      version: `${match[1]}.X-lts`,
      isLts: true,
      majorMinor: match[1]
    };
  }

  // Pattern for standard format with date: androidXX-X.X.X-YYYY-MM-AnyKernel3.zip
  // Example: android12-5.10.101-2022-04-AnyKernel3.zip
  match = filename.match(/android\d+-(\d+\.\d+\.\d+)-\d+-\d+-AnyKernel3\.zip/i);
  if (match) {
    const version = match[1];
    const parts = version.split('.');
    return {
      version: version,
      isLts: false,
      majorMinor: `${parts[0]}.${parts[1]}`
    };
  }

  return null;
}

// Check if file is AnyKernel3 (case-insensitive)
function isAnyKernel3(filename: string): boolean {
  const lowerName = filename.toLowerCase();
  return lowerName.includes('anykernel3') && lowerName.endsWith('.zip');
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

// Normalize user input version for matching
// Supports: "6.1", "6.1.X", "6.1.X-lts", "6.1.75", etc.
function normalizeVersion(input: string): string {
  let version = input.trim().toLowerCase();
  
  // Remove -lts suffix for comparison, we'll add it back if needed
  const isLtsRequest = version.endsWith('-lts');
  if (isLtsRequest) {
    version = version.slice(0, -4);
  }
  
  return version;
}

// Find matching AnyKernel3 file by kernel version
// Supports both exact match and LTS matching:
// - "5.10.101" matches android12-5.10.101-2022-04-AnyKernel3.zip
// - "6.1", "6.1.X", "6.1.X-lts" all match android14-6.1.X-lts-AnyKernel3.zip
function findMatchingAsset(assets: GitHubAsset[], kernelVersion: string): GitHubAsset | null {
  const normalizedInput = normalizeVersion(kernelVersion);
  const inputIsLtsRequest = kernelVersion.toLowerCase().includes('x') || 
                            kernelVersion.toLowerCase().endsWith('-lts') ||
                            kernelVersion.toLowerCase().endsWith('.x');

  for (const asset of assets) {
    if (!isAnyKernel3(asset.name)) continue;

    const versionInfo = extractKernelVersion(asset.name);
    if (!versionInfo) continue;

    // Exact match
    if (versionInfo.version.toLowerCase() === normalizedInput) {
      return asset;
    }

    // LTS matching: user inputs "6.1", "6.1.X", "6.1.X-lts" -> matches "6.1.X-lts"
    if (versionInfo.isLts) {
      // Check if user is looking for this LTS version
      const inputParts = normalizedInput.replace('-lts', '').split('.');
      if (inputParts.length >= 2) {
        const inputMajorMinor = `${inputParts[0]}.${inputParts[1]}`;
        if (versionInfo.majorMinor === inputMajorMinor) {
          // User's major.minor matches this LTS version
          if (inputIsLtsRequest || inputParts.length === 2 || inputParts[2] === 'x') {
            return asset;
          }
        }
      }
    }
  }

  return null;
}

// Get all available kernel versions from AnyKernel3 files
// Groups versions by major.minor and separates LTS versions
function getAvailableVersions(assets: GitHubAsset[]): { versions: string[], ltsVersions: string[] } {
  const versions: string[] = [];
  const ltsVersions: string[] = [];

  for (const asset of assets) {
    if (isAnyKernel3(asset.name)) {
      const versionInfo = extractKernelVersion(asset.name);
      if (versionInfo) {
        if (versionInfo.isLts) {
          // Add LTS version (avoid duplicates)
          if (!ltsVersions.includes(versionInfo.version)) {
            ltsVersions.push(versionInfo.version);
          }
        } else {
          // Add regular version
          versions.push(versionInfo.version);
        }
      }
    }
  }

  // Sort versions
  versions.sort((a, b) => {
    const aParts = a.split('.').map(Number);
    const bParts = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if ((aParts[i] || 0) !== (bParts[i] || 0)) {
        return (aParts[i] || 0) - (bParts[i] || 0);
      }
    }
    return 0;
  });

  // Sort LTS versions
  ltsVersions.sort((a, b) => {
    const aParts = a.replace('-lts', '').replace('.X', '').split('.').map(Number);
    const bParts = b.replace('-lts', '').replace('.X', '').split('.').map(Number);
    for (let i = 0; i < 2; i++) {
      if ((aParts[i] || 0) !== (bParts[i] || 0)) {
        return (aParts[i] || 0) - (bParts[i] || 0);
      }
    }
    return 0;
  });

  return { versions, ltsVersions };
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
      'Please specify a kernel version.\nUsage: <code>/get_gki &lt;version&gt;</code>\n\nExamples:\n• <code>/get_gki 5.10.101</code> - Standard GKI\n• <code>/get_gki 6.1</code> or <code>/get_gki 6.1.X-lts</code> - LTS kernel',
      'HTML',
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
      const versionInfo = extractKernelVersion(asset.name);
      const ltsNote = versionInfo?.isLts ? ' (LTS - Latest)' : '';
      const message = `Here's AnyKernel3 with the <b>${kernelVersion}${ltsNote}</b> kernel:

📥 Download: <a href="${asset.browser_download_url}">Click Here</a>

<b>📦 Kernel Info:</b>
• Root Solution: <a href="https://github.com/SukiSU-Ultra/SukiSU-Ultra">ReSukiSU</a>
• Includes: SUSFS (Root Hiding)
• Multi-Manager Support: ✅

💡 <i>ReSukiSU provides frequent updates and better root hiding for banking apps.</i>`;
      await sendMessage(botToken, chatId, message, 'HTML', replyToMessageId, messageThreadId);
    } else {
      const { versions, ltsVersions } = getAvailableVersions(release.assets);

      if (versions.length === 0 && ltsVersions.length === 0) {
        await sendMessage(
          botToken,
          chatId,
          '❌ No AnyKernel3 files found in the latest release.',
          'HTML',
          replyToMessageId,
          messageThreadId
        );
      } else {
        let message = `❌ Kernel version <b>${kernelVersion}</b> not found.\n\n`;
        
        if (ltsVersions.length > 0) {
          message += `<b>🔷 LTS Versions (Recommended):</b>\n`;
          message += ltsVersions.map(v => `• <code>${v}</code>`).join('\n');
          message += '\n\n';
        }
        
        if (versions.length > 0) {
          message += `<b>📦 Standard GKI Versions:</b>\n`;
          // Show first 20 versions to avoid message too long
          const displayVersions = versions.slice(-20);
          message += displayVersions.map(v => `• <code>${v}</code>`).join('\n');
          if (versions.length > 20) {
            message += `\n  ... and ${versions.length - 20} more`;
          }
        }
        
        message += `\n\n💡 Use <code>/list</code> to see all versions.`;
        
        await sendMessage(
          botToken,
          chatId,
          message,
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
  const message = `<b>GKI Kernel Download Bot</b>

This bot helps you download GKI kernels with <a href="https://github.com/SukiSU-Ultra/SukiSU-Ultra">ReSukiSU</a> and SUSFS.

<b>📦 About ReSukiSU:</b>
• Kernel-based root solution for Android
• Frequent updates & better root hiding
• SUSFS integration for banking apps
• Multi-Manager support (KowSU, SukiSU, etc.)

<b>Commands:</b>
• /get_gki &lt;version&gt; - Get AnyKernel3 for specific kernel version
• /list - List all available kernel versions
• /help - Show this help message

<b>Usage Examples:</b>
• <code>/get_gki 5.10.101</code> - Standard GKI kernel
• <code>/get_gki 6.1</code> - LTS kernel (6.1.X)
• <code>/get_gki 6.6.X-lts</code> - LTS kernel (6.6.X)`;
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

    const { versions, ltsVersions } = getAvailableVersions(release.assets);

    if (versions.length === 0 && ltsVersions.length === 0) {
      await sendMessage(
        botToken,
        chatId,
        '❌ No AnyKernel3 files found in the latest release.',
        'HTML',
        replyToMessageId,
        messageThreadId
      );
    } else {
      let message = `<b>Available Kernel Versions</b>\n`;
      message += `<b>Release:</b> ${release.tag_name}\n\n`;
      
      if (ltsVersions.length > 0) {
        message += `<b>🔷 LTS Versions (Recommended):</b>\n`;
        message += ltsVersions.map(v => `• <code>${v}</code>`).join('\n');
        message += '\n\n';
      }
      
      if (versions.length > 0) {
        message += `<b>📦 Standard GKI Versions:</b>\n`;
        // Group by major.minor for better readability
        const groupedVersions: Record<string, string[]> = {};
        for (const v of versions) {
          const parts = v.split('.');
          const key = `${parts[0]}.${parts[1]}`;
          if (!groupedVersions[key]) {
            groupedVersions[key] = [];
          }
          groupedVersions[key].push(v);
        }
        
        for (const [key, vals] of Object.entries(groupedVersions)) {
          message += `\n<code>${key}.x</code>: `;
          message += vals.map(v => v.split('.')[2]).join(', ');
        }
      }
      
      message += `\n\n💡 Use <code>/get_gki &lt;version&gt;</code> to download.`;
      message += `\n📌 LTS versions always contain the latest patch level.`;
      
      await sendMessage(
        botToken,
        chatId,
        message,
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
          { command: 'get_gki', description: 'Get GKI kernel by version (e.g., 6.1 or 5.10.101)' },
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
