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
  size?: number;
  digest?: string;  // Format: "sha256:xxxxx"
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

// OnePlus OKI (OnePlus Kernel) device info interface
interface OKIDeviceInfo {
  model: string;    // e.g., "ACE-5-RACE"
  os: string;       // e.g., "OOS16"
  fullId: string;   // e.g., "ACE-5-RACE_OOS16"
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

// Fetch latest release from GitHub with retry (handles transient errors / rate limiting)
async function fetchGitHubRelease(url: string, label: string): Promise<GitHubRelease | null> {
  const maxRetries = 2;
  const headers = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'Telegram-GKI-Bot'
  };

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, { headers });

      if (!response.ok) {
        const status = response.status;
        console.error(`${label} GitHub API error: ${status}`);
        if (status === 403) {
          // Rate limited — wait and retry
          if (attempt < maxRetries) {
            await new Promise(r => setTimeout(r, 2000 * attempt));
            continue;
          }
          return null;
        }
        if (status === 404) return null;
        // Other 5xx / 4xx — retry once
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 1000 * attempt));
          continue;
        }
        return null;
      }

      return await response.json() as GitHubRelease;
    } catch (error) {
      console.error(`${label} fetch error (attempt ${attempt}):`, error);
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 1000 * attempt));
        continue;
      }
      return null;
    }
  }
  return null;
}

// Fetch latest GKI release from GitHub
async function getLatestRelease(): Promise<GitHubRelease | null> {
  return fetchGitHubRelease(
    'https://api.github.com/repos/coolzyd9107/GKI_KernelSU_SUSFS/releases/latest',
    'GKI'
  );
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

// Send message and return message_id for later operations (like delete)
async function sendMessageAndGetId(
  botToken: string,
  chatId: number,
  text: string,
  parseMode: string = 'Markdown',
  replyToMessageId?: number,
  messageThreadId?: number
): Promise<number | null> {
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

  if (messageThreadId) {
    body.message_thread_id = messageThreadId;
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body)
    });

    const result = await response.json() as { ok?: boolean; result?: { message_id: number } };
    if (result.ok && result.result) {
      return result.result.message_id;
    }
    return null;
  } catch (error) {
    console.error('Error sending message:', error);
    return null;
  }
}

// Delete a message by chat_id and message_id
async function deleteMessage(
  botToken: string,
  chatId: number,
  messageId: number
): Promise<boolean> {
  const url = `https://api.telegram.org/bot${botToken}/deleteMessage`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId
      })
    });

    const result = await response.json() as { ok?: boolean };
    return result.ok === true;
  } catch (error) {
    console.error('Error deleting message:', error);
    return false;
  }
}

// Extract SHA256 hash short from digest string
function extractShaShort(digest: string | undefined): string {
  if (!digest) return '';
  // digest format: "sha256:75e0250c995cbe47fae8558cff3a8da58be52833a87ec93520c582e49121cb6b"
  const match = digest.match(/sha256:([a-f0-9]+)/i);
  if (match && match[1]) {
    return match[1].substring(0, 5).toLowerCase();  // First 5 characters
  }
  return '';
}

// ===== OnePlus OKI (OnePlus Kernel) Functions =====

// Extract device info from OnePlus kernel filename
// Example: AK3_OP-ACE-5-RACE_OOS16_android14-6.1.134_ReSukiSU_34681_SuSFS_v2.1.0.zip
// Returns: { model: "ACE-5-RACE", os: "OOS16", fullId: "ACE-5-RACE_OOS16" }
function extractOKIDeviceInfo(filename: string): OKIDeviceInfo | null {
  // Pattern: AK3_OP-{MODEL}_{OS}_android{VERSION}_...
  const match = filename.match(/AK3_OP-([A-Z0-9][A-Z0-9.-]*)_([A-Z0-9]+)_android\d+/i);
  if (match) {
    return {
      model: match[1],
      os: match[2],
      fullId: `${match[1]}_${match[2]}`
    };
  }
  return null;
}

// Fetch latest OnePlus OKI release from GitHub
async function getOKILatestRelease(): Promise<GitHubRelease | null> {
  return fetchGitHubRelease(
    'https://api.github.com/repos/huangdihd/OnePlus_ReSukiSU_SUSFS/releases/latest',
    'OKI'
  );
}

// Normalize string for case-insensitive comparison: lowercase and remove dashes/underscores
function normalizeForComparison(str: string): string {
  return str.toLowerCase().replace(/[-_\s]+/g, '');
}

// Find matching OKI asset by model and OS (case-insensitive)
// Supports flexible model matching: exact or substring (both directions)
// OS must match exactly (case-insensitive)
function findMatchingOKIAsset(assets: GitHubAsset[], modelInput: string, osInput: string): GitHubAsset | null {
  const normalizedModel = normalizeForComparison(modelInput);
  const normalizedOs = normalizeForComparison(osInput);

  for (const asset of assets) {
    if (!asset.name.toLowerCase().endsWith('.zip')) continue;

    const info = extractOKIDeviceInfo(asset.name);
    if (!info) continue;

    const normalizedFileModel = normalizeForComparison(info.model);
    const normalizedFileOs = normalizeForComparison(info.os);

    // OS must match exactly (case-insensitive, after normalization)
    if (normalizedFileOs !== normalizedOs) continue;

    // Model matching: exact match or substring match (both directions)
    if (normalizedFileModel === normalizedModel ||
        normalizedFileModel.includes(normalizedModel) ||
        normalizedModel.includes(normalizedFileModel)) {
      return asset;
    }
  }

  return null;
}

// Get all available device/model combinations from OKI releases
function getAvailableOKIDevices(assets: GitHubAsset[]): { devices: string[] } {
  const deviceMap = new Map<string, string[]>();

  for (const asset of assets) {
    if (!asset.name.toLowerCase().endsWith('.zip')) continue;

    const info = extractOKIDeviceInfo(asset.name);
    if (!info) continue;

    const osList = deviceMap.get(info.model) || [];
    if (!osList.includes(info.os)) {
      osList.push(info.os);
    }
    deviceMap.set(info.model, osList);
  }

  const devices: string[] = [];
  for (const [model, osList] of deviceMap.entries()) {
    for (const os of osList) {
      devices.push(`${model} (${os})`);
    }
  }

  return { devices };
}

// Send document to Telegram chat
async function sendDocument(
  botToken: string,
  chatId: number,
  fileData: ArrayBuffer,
  fileName: string,
  caption: string,
  replyToMessageId?: number,
  messageThreadId?: number
): Promise<boolean> {
  const url = `https://api.telegram.org/bot${botToken}/sendDocument`;

  const formData = new FormData();
  formData.append('chat_id', chatId.toString());
  formData.append('document', new Blob([fileData]), fileName);
  formData.append('caption', caption);
  formData.append('parse_mode', 'HTML');

  if (replyToMessageId) {
    formData.append('reply_to_message_id', replyToMessageId.toString());
  }

  if (messageThreadId) {
    formData.append('message_thread_id', messageThreadId.toString());
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      body: formData
    });

    const result = await response.json() as { ok?: boolean; description?: string };
    if (!result.ok) {
      console.error('Telegram sendDocument error:', result.description);
      return false;
    }
    return true;
  } catch (error) {
    console.error('Error sending document:', error);
    return false;
  }
}

// Handle /dl command - Download and upload kernel file
async function handleDownload(
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
      'Please specify a kernel version.\nUsage: <code>/dl &lt;version&gt;</code>\n\nExamples:\n• <code>/dl 6.6.66</code>\n• <code>/dl 5.10.101</code>\n• <code>/dl 6.1</code> (LTS)',
      'HTML',
      replyToMessageId,
      messageThreadId
    );
    return;
  }

  // Send "downloading" status message and save its ID for later deletion
  const statusMessageId = await sendMessageAndGetId(
    botToken,
    chatId,
    `⏳ <i>Downloading kernel ${kernelVersion}...</i>`,
    'HTML',
    replyToMessageId,
    messageThreadId
  );

  try {
    const release = await getLatestRelease();

    if (!release) {
      if (statusMessageId) await deleteMessage(botToken, chatId, statusMessageId);
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

    if (!asset) {
      const { versions, ltsVersions } = getAvailableVersions(release.assets);
      let message = `❌ Kernel version <b>${kernelVersion}</b> not found.\n\n`;
      
      if (ltsVersions.length > 0) {
        message += `<b>🔷 LTS Versions:</b>\n`;
        message += ltsVersions.map(v => `• <code>${v}</code>`).join('\n');
        message += '\n\n';
      }
      
      if (versions.length > 0) {
        message += `<b>📦 Standard GKI:</b> `;
        message += versions.slice(-10).join(', ');
        if (versions.length > 10) {
          message += ` ...and ${versions.length - 10} more`;
        }
      }
      
      if (statusMessageId) await deleteMessage(botToken, chatId, statusMessageId);
      await sendMessage(botToken, chatId, message, 'HTML', replyToMessageId, messageThreadId);
      return;
    }

    // Check file size (Telegram limit: 50MB for bots)
    const maxSize = 50 * 1024 * 1024; // 50MB
    if (asset.size && asset.size > maxSize) {
      if (statusMessageId) await deleteMessage(botToken, chatId, statusMessageId);
      await sendMessage(
        botToken,
        chatId,
        `❌ File too large (${(asset.size / 1024 / 1024).toFixed(1)}MB). Telegram bot limit is 50MB.\n\nPlease use the direct download link:\n${asset.browser_download_url}`,
        'HTML',
        replyToMessageId,
        messageThreadId
      );
      return;
    }

    // Download the file
    const downloadResponse = await fetch(asset.browser_download_url);
    if (!downloadResponse.ok) {
      if (statusMessageId) await deleteMessage(botToken, chatId, statusMessageId);
      await sendMessage(
        botToken,
        chatId,
        '❌ Failed to download file from GitHub. Please try again later.',
        'HTML',
        replyToMessageId,
        messageThreadId
      );
      return;
    }

    const fileData = await downloadResponse.arrayBuffer();

    // Generate new filename: original_name (without .zip) + _SHASHORT.zip
    const originalName = asset.name.replace(/\.zip$/i, '');
    const shaShort = extractShaShort(asset.digest);
    const newFileName = shaShort ? `${originalName}_${shaShort}.zip` : `${originalName}.zip`;

    // Generate caption
    const versionInfo = extractKernelVersion(asset.name);
    const ltsNote = versionInfo?.isLts ? ' (LTS)' : '';
    const sizeMB = (fileData.byteLength / 1024 / 1024).toFixed(1);
    const caption = `<b>${versionInfo?.version || kernelVersion}${ltsNote}</b> GKI Kernel

📦 Size: ${sizeMB}MB
🔐 SHA256: ${shaShort || 'N/A'}...

<a href="https://github.com/ReSukiSU/ReSukiSU">ReSukiSU</a> + SUSFS`;

    // Send the file
    const success = await sendDocument(
      botToken,
      chatId,
      fileData,
      newFileName,
      caption,
      replyToMessageId,
      messageThreadId
    );

    // Delete the "downloading" status message after file is sent
    if (statusMessageId) {
      await deleteMessage(botToken, chatId, statusMessageId);
    }

    if (!success) {
      await sendMessage(
        botToken,
        chatId,
        '❌ Failed to upload file to Telegram. The file might be too large or an error occurred.\n\nPlease use the direct download link:\n' + asset.browser_download_url,
        'HTML',
        replyToMessageId,
        messageThreadId
      );
    }

  } catch (error) {
    console.error('Error handling /dl:', error);
    if (statusMessageId) await deleteMessage(botToken, chatId, statusMessageId);
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
• Root Solution: <a href="https://github.com/ReSukiSU/ReSukiSU">ReSukiSU</a>
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

// Handle /get_oki command - Get download link for OnePlus kernel
async function handleGetOKI(
  botToken: string,
  chatId: number,
  args: string | null,
  replyToMessageId?: number,
  messageThreadId?: number
): Promise<void> {
  if (!args) {
    await sendMessage(
      botToken,
      chatId,
      'Please specify a device model and OS version.\nUsage: <code>/get_oki &lt;model&gt; &lt;os&gt;</code>\n\nExamples:\n• <code>/get_oki ace-5-race oos16</code>\n• <code>/get_oki ACE-5-RACE OOS16</code>\n\n💡 Model and OS are case-insensitive.',
      'HTML',
      replyToMessageId,
      messageThreadId
    );
    return;
  }

  // Parse arguments: first arg is model, second is OS
  const parts = args.trim().split(/\s+/);
  if (parts.length < 2) {
    await sendMessage(
      botToken,
      chatId,
      '❌ Invalid arguments. Please provide both model and OS.\nUsage: <code>/get_oki &lt;model&gt; &lt;os&gt;</code>\n\nExample: <code>/get_oki ace-5-race oos16</code>',
      'HTML',
      replyToMessageId,
      messageThreadId
    );
    return;
  }

  const modelInput = parts[0];
  const osInput = parts[1];

  try {
    const release = await getOKILatestRelease();

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

    const asset = findMatchingOKIAsset(release.assets, modelInput, osInput);

    if (asset) {
      const info = extractOKIDeviceInfo(asset.name);
      const kernelMatch = asset.name.match(/android(\d+)-(\d+\.\d+\.\d+)/i);
      const androidVer = kernelMatch ? kernelMatch[1] : '?';
      const kernelVer = kernelMatch ? kernelMatch[2] : '?';
      const message = `Here's AnyKernel3 for <b>${info?.fullId || args}</b>:

📥 Download: <a href="${asset.browser_download_url}">Click Here</a>

<b>📦 Kernel Info:</b>
• Device: <code>${info?.model || modelInput}</code>
• OS: <code>${info?.os || osInput}</code>
• Android: ${androidVer} | Kernel: ${kernelVer}
• Root Solution: <a href="https://github.com/ReSukiSU/ReSukiSU">ReSukiSU</a>
• Includes: SUSFS (Root Hiding)

💡 <i>ReSukiSU provides frequent updates and better root hiding for banking apps.</i>`;
      await sendMessage(botToken, chatId, message, 'HTML', replyToMessageId, messageThreadId);
    } else {
      const { devices } = getAvailableOKIDevices(release.assets);

      if (devices.length === 0) {
        await sendMessage(
          botToken,
          chatId,
          '❌ No OnePlus kernel files found in the latest release.',
          'HTML',
          replyToMessageId,
          messageThreadId
        );
      } else {
        let message = `❌ Device <b>${modelInput}</b> with OS <b>${osInput}</b> not found.\n\n`;
        message += `<b>📱 Available Devices:</b>\n`;
        message += devices.map(d => `• <code>${d}</code>`).join('\n');
        message += `\n\n💡 Usage: <code>/get_oki &lt;model&gt; &lt;os&gt;</code>`;

        await sendMessage(botToken, chatId, message, 'HTML', replyToMessageId, messageThreadId);
      }
    }
  } catch (error) {
    console.error('Error handling /get_oki:', error);
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

// Handle /oki command - Download and upload OnePlus kernel file
async function handleDownloadOKI(
  botToken: string,
  chatId: number,
  args: string | null,
  replyToMessageId?: number,
  messageThreadId?: number
): Promise<void> {
  if (!args) {
    await sendMessage(
      botToken,
      chatId,
      'Please specify a device model and OS version.\nUsage: <code>/oki &lt;model&gt; &lt;os&gt;</code>\n\nExamples:\n• <code>/oki ace-5-race oos16</code>\n• <code>/oki ACE-5-RACE OOS16</code>\n\n💡 Model and OS are case-insensitive.',
      'HTML',
      replyToMessageId,
      messageThreadId
    );
    return;
  }

  const parts = args.trim().split(/\s+/);
  if (parts.length < 2) {
    await sendMessage(
      botToken,
      chatId,
      '❌ Invalid arguments. Please provide both model and OS.\nUsage: <code>/oki &lt;model&gt; &lt;os&gt;</code>\n\nExample: <code>/oki ace-5-race oos16</code>',
      'HTML',
      replyToMessageId,
      messageThreadId
    );
    return;
  }

  const modelInput = parts[0];
  const osInput = parts[1];

  // Send "downloading" status message
  const statusMessageId = await sendMessageAndGetId(
    botToken,
    chatId,
    `⏳ <i>Downloading OnePlus kernel for ${modelInput} ${osInput}...</i>`,
    'HTML',
    replyToMessageId,
    messageThreadId
  );

  try {
    const release = await getOKILatestRelease();

    if (!release) {
      if (statusMessageId) await deleteMessage(botToken, chatId, statusMessageId);
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

    const asset = findMatchingOKIAsset(release.assets, modelInput, osInput);

    if (!asset) {
      const { devices } = getAvailableOKIDevices(release.assets);
      let message = `❌ Device <b>${modelInput}</b> with OS <b>${osInput}</b> not found.\n\n`;

      if (devices.length > 0) {
        message += `<b>📱 Available Devices:</b>\n`;
        message += devices.map(d => `• <code>${d}</code>`).join('\n');
      }

      if (statusMessageId) await deleteMessage(botToken, chatId, statusMessageId);
      await sendMessage(botToken, chatId, message, 'HTML', replyToMessageId, messageThreadId);
      return;
    }

    // Check file size (Telegram limit: 50MB for bots)
    const maxSize = 50 * 1024 * 1024; // 50MB
    if (asset.size && asset.size > maxSize) {
      if (statusMessageId) await deleteMessage(botToken, chatId, statusMessageId);
      await sendMessage(
        botToken,
        chatId,
        `❌ File too large (${(asset.size / 1024 / 1024).toFixed(1)}MB). Telegram bot limit is 50MB.\n\nPlease use the direct download link:\n${asset.browser_download_url}`,
        'HTML',
        replyToMessageId,
        messageThreadId
      );
      return;
    }

    // Download the file
    const downloadResponse = await fetch(asset.browser_download_url);
    if (!downloadResponse.ok) {
      if (statusMessageId) await deleteMessage(botToken, chatId, statusMessageId);
      await sendMessage(
        botToken,
        chatId,
        '❌ Failed to download file from GitHub. Please try again later.',
        'HTML',
        replyToMessageId,
        messageThreadId
      );
      return;
    }

    const fileData = await downloadResponse.arrayBuffer();

    // Generate filename with SHA short
    const originalName = asset.name.replace(/\.zip$/i, '');
    const shaShort = extractShaShort(asset.digest);
    const newFileName = shaShort ? `${originalName}_${shaShort}.zip` : `${originalName}.zip`;

    // Generate caption
    const info = extractOKIDeviceInfo(asset.name);
    const sizeMB = (fileData.byteLength / 1024 / 1024).toFixed(1);
    const caption = `<b>${info?.fullId || args}</b> OnePlus Kernel

📦 Size: ${sizeMB}MB
🔐 SHA256: ${shaShort || 'N/A'}...

<a href="https://github.com/ReSukiSU/ReSukiSU">ReSukiSU</a> + SUSFS`;

    // Send the file
    const success = await sendDocument(
      botToken,
      chatId,
      fileData,
      newFileName,
      caption,
      replyToMessageId,
      messageThreadId
    );

    // Delete the status message after file is sent
    if (statusMessageId) {
      await deleteMessage(botToken, chatId, statusMessageId);
    }

    if (!success) {
      await sendMessage(
        botToken,
        chatId,
        '❌ Failed to upload file to Telegram. The file might be too large or an error occurred.\n\nPlease use the direct download link:\n' + asset.browser_download_url,
        'HTML',
        replyToMessageId,
        messageThreadId
      );
    }
  } catch (error) {
    console.error('Error handling /oki:', error);
    if (statusMessageId) await deleteMessage(botToken, chatId, statusMessageId);
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

This bot helps you download GKI kernels with <a href="https://github.com/ReSukiSU/ReSukiSU">ReSukiSU</a> and SUSFS.

<b>📦 About ReSukiSU:</b>
• Kernel-based root solution for Android
• Frequent updates & better root hiding
• SUSFS integration for banking apps
• Multi-Manager support (KowSU, SukiSU, etc.)

<b>📦 GKI Kernel Commands:</b>
• /get_gki &lt;version&gt; - Get download link for kernel
• /dl &lt;version&gt; - Download & send kernel file directly
• /list - List all available kernel versions

<b>📱 OnePlus Kernel Commands:</b>
• /get_oki &lt;model&gt; &lt;os&gt; - Get OnePlus kernel download link
• /oki &lt;model&gt; &lt;os&gt; - Download & send OnePlus kernel file directly

<b>Other:</b>
• /help - Show this help message

<b>Usage Examples:</b>
• <code>/get_gki 6.6.66</code> - Get GKI download link
• <code>/dl 6.1</code> - Download GKI LTS kernel
• <code>/get_oki ace-5-race oos16</code> - Get OnePlus download link
• <code>/oki ACE-5-RACE OOS16</code> - Download OnePlus kernel

💡 All model and OS inputs are <b>case-insensitive</b>.`;
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
      
      message += `\n\n💡 Use <code>/get_gki &lt;version&gt;</code> to get download link.`;
      message += `\n💡 Use <code>/dl &lt;version&gt;</code> to receive file directly.`;
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
            case '/dl':
              await handleDownload(env.BOT_TOKEN, chatId, args || null, messageId, threadId);
              break;
            case '/get_oki':
              await handleGetOKI(env.BOT_TOKEN, chatId, args || null, messageId, threadId);
              break;
            case '/oki':
              await handleDownloadOKI(env.BOT_TOKEN, chatId, args || null, messageId, threadId);
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
            case '/dl':
              await handleDownload(env.BOT_TOKEN, chatId, args || null, messageId, threadId);
              break;
            case '/get_oki':
              await handleGetOKI(env.BOT_TOKEN, chatId, args || null, messageId, threadId);
              break;
            case '/oki':
              await handleDownloadOKI(env.BOT_TOKEN, chatId, args || null, messageId, threadId);
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
          version: '1.1.0'
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
          { command: 'get_gki', description: 'Get download link for kernel version' },
          { command: 'dl', description: 'Download & send kernel file directly' },
          { command: 'list', description: 'List available kernel versions' },
          { command: 'get_oki', description: 'Get download link for OnePlus kernel' },
          { command: 'oki', description: 'Download & send OnePlus kernel file directly' }
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
