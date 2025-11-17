const { Client } = require('discord.js-selfbot-v13');
const axios = require('axios');
const puppeteer = require('puppeteer');

// Use environment variable for token (more secure)
const TOKEN = process.env.DISCORD_TOKEN;

if (!TOKEN) {
  console.error('Error: DISCORD_TOKEN environment variable is not set!');
  process.exit(1);
}

const MONITOR_CHANNEL_IDS = [
  '430203025659789343', 
  '442709792839172099', 
  '442709710408515605',
  '749645946719174757',
  '808540135666745345'
];

const CHANNEL_MAPPING = {
  '430203025659789343': '1393342132583927821',
  '442709792839172099': '1403939114683863180',
  '442709710408515605': '1403939122904825856',
  '749645946719174757': '1393342132583927821',
  '808540135666745345': '1393342132583927821'
};

const SKIP_ROLE_FILTER_GUILDS = [
  '786851062219931690',
  '749629643836882975'
];

const WEBHOOK_URL = 'https://discord.com/api/webhooks/1403167152751513642/Hm5U3_t_D8VYMN9Q3qUXnhzKGSeM2F-f3CyKVdedbH_k9BDPHYPGAsewO24FXepjIUzm';
const PRIVATE_INVENTORY_WEBHOOK_URL = 'https://discord.com/api/webhooks/1439812793384697926/oa5Ey82H1YKDRwiu0wmKSLax_Q5iIyqu3MXcARJFitvjSI1l8rtce9MFaJZb-cML-R1L';
const BOT_ID = '298796807323123712';

const ALLOWED_ROLES = [
  "Verified", "Nitro Booster", "200k Members", "Game Night", "Weeb",
  "Art Talk", "Music", "Pets", "Rolimon's News Pings", "Content Pings",
  "Roblox News Pings", "Trading News Pings", "Limited Pings", "UGC Limited Pings",
  "-Free UGC Limited Pings", "Free UGC Limited Game Pings", "Upcoming UGC Limiteds Ping",
  "Free UGC Event Pings", "Poll Pings", "Value Change Pings", "Projection Pings"
];

// Value threshold: 100k
const VALUE_THRESHOLD = 100000;

let blockedUsers = new Set();

async function fetchBlockedUsers() {
  try {
    const res = await axios.get('https://discord.com/api/v9/users/@me/relationships', {
      headers: { Authorization: TOKEN }
    });
    blockedUsers = new Set(res.data.filter(u => u.type === 2).map(u => u.id));
    console.log('Blocked users loaded:', blockedUsers.size);
  } catch (error) {
    console.error('Error fetching blocked users:', error.message);
  }
}

// OPTIMIZED: Puppeteer browser (faster than Selenium)
let browser = null;

async function initializeBrowser() {
  if (browser) return browser;
  
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
        '--disable-extensions',
        '--disable-plugins',
        '--memory-pressure-off'
      ]
    });
    console.log('✅ Puppeteer browser initialized');
    return browser;
  } catch (error) {
    console.error('❌ Browser initialization error:', error.message);
    return null;
  }
}

// ULTRA FAST: Use Roblox API (much faster than scraping Rolimons)
async function fetchRobloxRAP(robloxUserId) {
  let rap = 0;
  let cursor = undefined;
  
  try {
    while (true) {
      const { data } = await axios.get(
        `https://inventory.roblox.com/v1/users/${robloxUserId}/assets/collectibles`,
        { 
          params: { limit: 100, sortOrder: 'Asc', cursor },
          timeout: 3000
        }
      );
      
      if (!data || !Array.isArray(data.data) || data.data.length === 0) break;
      
      for (const entry of data.data) {
        rap += Number(entry.recentAveragePrice || 0);
      }
      
      if (data.nextPageCursor) cursor = data.nextPageCursor;
      else break;
    }
  } catch (error) {
    console.log(`[Monitor] Error fetching RAP: ${error.message}`);
  }
  
  return rap;
}

async function fetchRobloxAvatar(robloxUserId) {
  try {
    const { data } = await axios.get('https://thumbnails.roblox.com/v1/users/avatar-headshot', {
      params: { userIds: robloxUserId, size: '150x150', format: 'Png', isCircular: false },
      timeout: 2000
    });
    return (data?.data?.[0]?.imageUrl) || '';
  } catch (error) {
    return '';
  }
}

// FAST: Try Roblox API first, then Rolimons HTML, then Puppeteer fallback
async function scrapeRolimons(robloxUserId) {
  const rolimonsUrl = `https://www.rolimons.com/player/${robloxUserId}`;
  
  // METHOD 1: Check Rolimons HTML first to detect private inventory
  let tradeAds = 0;
  let isPrivate = false;
  try {
    const response = await axios.get(rolimonsUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html'
      },
      timeout: 2000
    });
    
    const html = response.data;
    
    // Check for private inventory indicator
    if (html.includes('inventory is private') || html.toLowerCase().includes('value') && html.toLowerCase().includes('unknown')) {
      isPrivate = true;
    }
    
    const playerDataMatch = html.match(/var\s+player_details_data\s*=\s*({[^;]+});/);
    if (playerDataMatch) {
      const playerData = JSON.parse(playerDataMatch[1]);
      tradeAds = playerData.trade_ad_count || 0;
    }
  } catch (error) {
    // If HTML extraction fails, try Puppeteer
  }
  
  // If private inventory detected, return early
  if (isPrivate) {
    const avatarUrl = await fetchRobloxAvatar(robloxUserId);
    return { 
      value: 'Unknown',
      tradeAds, 
      avatarUrl, 
      rolimonsUrl 
    };
  }
  
  // METHOD 2: Roblox API (FASTEST - ~200-500ms for RAP + avatar)
  try {
    const [rap, avatarUrl] = await Promise.all([
      fetchRobloxRAP(robloxUserId),
      fetchRobloxAvatar(robloxUserId)
    ]);
    
    // Use RAP as value (Roblox API doesn't have Rolimons' "value", but RAP is similar)
    return { 
      value: rap,
      tradeAds, 
      avatarUrl, 
      rolimonsUrl 
    };
    
  } catch (error) {
    console.log(`[Monitor] Roblox API failed, using Rolimons fallback: ${error.message}`);
  }
  
  // METHOD 3: Puppeteer fallback (slower but reliable)
  return await scrapeRolimonsPuppeteer(robloxUserId);
}

async function scrapeRolimonsPuppeteer(robloxUserId) {
  const url = `https://www.rolimons.com/player/${robloxUserId}`;
  
  if (!browser) {
    await initializeBrowser();
  }
  
  if (!browser) {
    return { value: 0, tradeAds: 0, avatarUrl: '', rolimonsUrl: url };
  }

  let page = null;
  try {
    page = await browser.newPage();
    
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    
    await page.goto(url, { 
      waitUntil: 'domcontentloaded', 
      timeout: 5000 
    });
    
    await page.waitForFunction(
      () => {
        const elem = document.getElementById('player_value');
        return elem && elem.textContent.trim() !== '' && elem.textContent.trim() !== '&nbsp;';
      },
      { timeout: 1500, polling: 30 }
    ).catch(() => {});
    
    await new Promise(resolve => setTimeout(resolve, 50));
    
    const data = await page.evaluate(() => {
      let value = 0, tradeAds = 0, avatarUrl = '';
      
      try {
        const valueElem = document.getElementById('player_value');
        if (valueElem) {
          const valueText = valueElem.textContent.replace(/,/g, '').trim().toLowerCase();
          // Check if value is "Unknown" (private inventory)
          if (valueText === 'unknown' || valueText.includes('unknown')) {
            value = 'Unknown';
          } else {
            value = parseInt(valueText) || 0;
          }
        }
      } catch (e) {}
      
      try {
        const tradeAdsContainer = document.querySelector('.trade-ads-created-container');
        if (tradeAdsContainer) {
          const tradeAdsElem = tradeAdsContainer.querySelector('.card-title.mb-1.text-light.stat-data.text-nowrap');
          if (tradeAdsElem) {
            const tradeAdsText = tradeAdsElem.textContent.replace(/,/g, '').trim();
            tradeAds = parseInt(tradeAdsText) || 0;
          }
        }
      } catch (e) {
        try {
          const headers = Array.from(document.querySelectorAll('h6'));
          const tradeAdsHeader = headers.find(h => h.textContent.includes('Trade Ads Created'));
          if (tradeAdsHeader) {
            const parent = tradeAdsHeader.parentElement;
            const tradeAdsElem = parent.querySelector('.card-title.mb-1.text-light.stat-data.text-nowrap');
            if (tradeAdsElem) {
              const tradeAdsText = tradeAdsElem.textContent.replace(/,/g, '').trim();
              tradeAds = parseInt(tradeAdsText) || 0;
            }
          }
        } catch (e2) {}
      }
      
      try {
        const avatarElem = document.querySelector('img.mx-auto.d-block.w-100.h-100');
        if (avatarElem) {
          avatarUrl = avatarElem.src || '';
        }
      } catch (e) {}
      
      return { value, tradeAds, avatarUrl };
    });
    
    await page.close();
    
    return { 
      value: data.value, 
      tradeAds: data.tradeAds, 
      avatarUrl: data.avatarUrl, 
      rolimonsUrl: url 
    };
    
  } catch (error) {
    console.error('Error scraping Rolimons:', error.message);
    if (page) {
      try {
        await page.close();
      } catch {}
    }
    return { value: 0, tradeAds: 0, avatarUrl: '', rolimonsUrl: url };
  }
}

const client = new Client({ checkUpdate: false });

let processedUsers = new Set();
let pendingRoblox = new Map();
let webhookSent = new Set();
let lookupAttempted = new Set();
let pendingWhoisRequests = new Map();

// OPTIMIZED: Cache whois channels
let whoisChannelsCache = new Map();

client.on('ready', async () => {
  console.log(`[Monitor] Logged in as ${client.user.tag}`);
  await fetchBlockedUsers();
  await initializeBrowser();
  
  // OPTIMIZED: Pre-fetch and cache whois channels
  console.log('[Monitor] Caching whois channels...');
  const uniqueWhoisChannelIds = [...new Set(Object.values(CHANNEL_MAPPING))];
  for (const channelId of uniqueWhoisChannelIds) {
    try {
      const channel = await client.channels.fetch(channelId);
      whoisChannelsCache.set(channelId, channel);
      console.log(`[Monitor] Cached whois channel: ${channelId}`);
    } catch (error) {
      console.error(`[Monitor] Failed to cache channel ${channelId}:`, error.message);
    }
  }
  
  console.log(`[Monitor] Bot ready and monitoring ${MONITOR_CHANNEL_IDS.length} channels!`);
  console.log(`[Monitor] Channels: ${MONITOR_CHANNEL_IDS.join(', ')}`);
  console.log(`[Monitor] Channel mapping:`, CHANNEL_MAPPING);
});

client.on('messageCreate', async (message) => {
  // OPTIMIZED: Early returns first (fastest checks)
  if (message.author.bot) return;
  if (blockedUsers.has(message.author.id)) return;
  if (processedUsers.has(message.author.id)) return;
  if (lookupAttempted.has(message.author.id)) return;
  if (!MONITOR_CHANNEL_IDS.includes(message.channel.id)) return;

  // OPTIMIZED: Get whois channel ID early (before member fetch)
  const whoisChannelId = CHANNEL_MAPPING[message.channel.id];
  if (!whoisChannelId) return;

  // OPTIMIZED: Use cached channel instead of fetching
  let whoisChannel = whoisChannelsCache.get(whoisChannelId);
  if (!whoisChannel) {
    try {
      whoisChannel = await client.channels.fetch(whoisChannelId);
      whoisChannelsCache.set(whoisChannelId, whoisChannel);
    } catch {
      return;
    }
  }

  // OPTIMIZED: Check member cache first, only fetch if needed
  let member = message.member;
  if (!member && message.guild) {
    member = message.guild.members.cache.get(message.author.id);
    if (!member) {
      try {
        member = await message.guild.members.fetch(message.author.id);
      } catch {
        return;
      }
    }
  }
  if (!member) return;

  // Check if role filtering should be applied based on guild
  const shouldApplyRoleFilter = !SKIP_ROLE_FILTER_GUILDS.includes(message.guild.id);
  
  if (shouldApplyRoleFilter) {
    // OPTIMIZED: Use cache directly (already cached)
    const userRoleNames = member.roles.cache.filter(r => r.name !== '@everyone').map(r => r.name);
    const onlyAllowedRoles = userRoleNames.length > 0 && userRoleNames.every(roleName => ALLOWED_ROLES.includes(roleName));
    if (!onlyAllowedRoles) return;
  } else {
    console.log(`[Monitor] Skipping role filter for guild ${message.guild.id} (${message.guild.name})`);
  }

  lookupAttempted.add(message.author.id);

  const messageData = {
    discordId: message.author.id,
    discordTag: message.author.tag,
    content: message.content,
    timestamp: message.createdTimestamp,
    channelId: message.channel.id,
    channelName: message.channel.name,
    messageId: message.id,
    guildId: message.guild.id,
    whoisChannelId: whoisChannelId
  };

  pendingWhoisRequests.set(message.author.id, messageData);
  
  // OPTIMIZED: Use cached channel (no await needed for fetch)
  try {
    // Try full command string format first
    await whoisChannel.sendSlash(BOT_ID, 'whois discord', message.author.id);
    console.log(`[Monitor] Sent /whois discord for ${message.author.tag} (${message.author.id}) in #${message.channel.name} -> whois channel ${whoisChannelId}`);
  } catch (error) {
    // Fallback: Try with subcommand and options array
    try {
      await whoisChannel.sendSlash(BOT_ID, 'whois', 'discord', [{ name: 'user', value: message.author.id }]);
      console.log(`[Monitor] Sent /whois discord (fallback format) for ${message.author.tag} (${message.author.id})`);
    } catch (error2) {
      console.error(`[Monitor] Failed to send /whois command:`, error.message);
      pendingWhoisRequests.delete(message.author.id);
      lookupAttempted.delete(message.author.id);
    }
  }
});

// Handle whois responses - FIXED MATCHING LOGIC
client.on('messageCreate', async (message) => {
  const whoisChannelIds = Object.values(CHANNEL_MAPPING);
  
  if (
    message.author.id === BOT_ID &&
    whoisChannelIds.includes(message.channel.id) &&
    message.embeds &&
    message.embeds.length > 0 &&
    message.embeds[0].fields
  ) {
    let robloxUserId = '';
    let discordTag = '';
    let discordId = '';

    // Extract Roblox User ID and Discord username/tag from embed
    const embed = message.embeds[0];
    const fields = embed.fields || [];
    
    // Extract Roblox User ID from fields
    for (const field of fields) {
      const fieldNameLower = field.name.toLowerCase();
      const fieldValue = field.value;
      
      if (fieldNameLower.includes('roblox user id')) {
        robloxUserId = fieldValue.replace(/`/g, '').trim();
      }
    }
    
    // Extract Discord username/tag - check embed title, description, and fields
    // The Discord username usually appears at the top of the embed (like "jakrouse#0")
    if (embed.title) {
      // Sometimes the Discord username is in the title
      const titleMatch = embed.title.match(/([a-zA-Z0-9_.]+#\d+)/);
      if (titleMatch) {
        discordTag = titleMatch[1];
      }
    }
    
    // Check description for Discord username (usually first line)
    if (!discordTag && embed.description) {
      // Try to match Discord tag pattern (username#discriminator)
      const descMatch = embed.description.match(/([a-zA-Z0-9_.]+#\d+)/);
      if (descMatch) {
        discordTag = descMatch[1];
      }
    }
    
    // Also check the first line of description more specifically
    if (!discordTag && embed.description) {
      const firstLine = embed.description.split('\n')[0];
      const firstLineMatch = firstLine.match(/([a-zA-Z0-9_.]+#\d+)/);
      if (firstLineMatch) {
        discordTag = firstLineMatch[1];
      }
    }
    
    // Check fields for Discord username
    if (!discordTag) {
      for (const field of fields) {
        const fieldNameLower = field.name.toLowerCase();
        const fieldValue = field.value;
        
        if (fieldNameLower.includes('discord')) {
          const tagMatch = fieldValue.match(/([a-zA-Z0-9_.]+#\d+)/);
          if (tagMatch) {
            discordTag = tagMatch[1];
            break;
          }
        }
      }
    }
    
    // Also check the embed author or footer
    if (!discordTag && embed.author && embed.author.name) {
      const authorMatch = embed.author.name.match(/([a-zA-Z0-9_.]+#\d+)/);
      if (authorMatch) {
        discordTag = authorMatch[1];
      }
    }
    
    // Debug logging to see what we extracted
    if (discordTag) {
      console.log(`[Monitor] Extracted Discord tag from embed: ${discordTag}`);
    } else {
      console.log(`[Monitor] ⚠ Could not extract Discord tag from embed. Title: ${embed.title}, Description: ${embed.description?.substring(0, 100)}`);
    }

    if (!robloxUserId || !discordTag) {
      console.log(`[Monitor] ⚠ Received whois response but missing Roblox User ID or Discord tag. Ignoring.`);
      return;
    }

    // Process directly from embed - no matching needed
    // Remove discriminator from Discord tag
    const discordUsername = discordTag.split('#')[0];
    
    console.log(`[Monitor] Processing whois response for ${discordTag} (Roblox ID: ${robloxUserId})`);
    
    // Process immediately without waiting for other users (parallel processing)
    processUserFromEmbed(discordTag, discordUsername, robloxUserId).catch(err => {
      console.error(`[Monitor] Error processing user ${discordTag}:`, err.message);
    });
  }
});

// Process user directly from embed data (no matching needed)
async function processUserFromEmbed(discordTag, discordUsername, robloxUserId) {
  const { value, tradeAds, avatarUrl, rolimonsUrl } = await scrapeRolimons(robloxUserId);
  console.log(`[Monitor] Scraped value: ${value}, tradeAds: ${tradeAds} for ${discordTag}`);

  // Check if inventory is private (value is "Unknown" or similar)
  const isPrivateInventory = (typeof value === 'string' && value.toLowerCase().includes('unknown')) || 
                             (typeof value === 'number' && value === 0 && tradeAds === 0);
  
  if (isPrivateInventory) {
    // Send to private inventory webhook
    try {
      await axios.post(PRIVATE_INVENTORY_WEBHOOK_URL, {
        content: '@everyone',
        embeds: [
          {
            title: 'Private Inventory Detected',
            description: `**Discord:** ${discordUsername}\n**Roblox User ID:** ${robloxUserId}\n**Value:** Unknown (Private Inventory)\n[Rolimons Profile](${rolimonsUrl})`,
            color: 0xff9900,
            thumbnail: { url: avatarUrl }
          }
        ]
      });
      console.log(`[Monitor] ✓ Sent private inventory webhook for ${discordTag}`);
    } catch (error) {
      console.error('Error sending private inventory webhook:', error.message);
    }
    return;
  }

  // Check if trade ads is over 1,000 - if so, skip this user
  if (tradeAds >= 1000) {
    console.log(`[Monitor] User has too many trade ads (${tradeAds} >= 1000), skipping...`);
    return;
  }

  // Check if value meets threshold (100k) - skip if value is "Unknown"
  if (typeof value === 'number' && value >= VALUE_THRESHOLD) {
    try {
      await axios.post(WEBHOOK_URL, {
        content: '@everyone',
        embeds: [
          {
            title: 'User Detected',
            description: `**Discord:** ${discordUsername}\n**Roblox User ID:** ${robloxUserId}\n[Rolimons Profile](${rolimonsUrl})`,
            color: 0x00ff00
          },
          {
            title: 'Rolimons Info',
            description: `**Value:** ${typeof value === 'number' ? value.toLocaleString() : value}\n**Trade Ads:** ${tradeAds}\n[Rolimons Profile](${rolimonsUrl})`,
            color: 0x00ff00,
            thumbnail: { url: avatarUrl }
          }
        ]
      });
      console.log(`[Monitor] ✓ Sent webhook for ${discordTag} with value ${typeof value === 'number' ? value.toLocaleString() : value}!`);
    } catch (error) {
      console.error('Error sending webhook:', error.message);
    }
  } else {
    console.log(`[Monitor] User did not meet value requirement (${typeof value === 'number' ? value.toLocaleString() : value} < ${VALUE_THRESHOLD.toLocaleString()}).`);
  }
}

// Separate function for processing - allows parallel execution (legacy, kept for compatibility)
async function processUser(discordId, robloxUserId, messageData) {
  const { value, tradeAds, avatarUrl, rolimonsUrl } = await scrapeRolimons(robloxUserId);
  console.log(`[Monitor] Scraped value: ${value.toLocaleString()}, tradeAds: ${tradeAds} for ${messageData.discordTag}`);

  // Check if trade ads is over 1,000 - if so, skip this user
  if (tradeAds >= 1000) {
    console.log(`[Monitor] User has too many trade ads (${tradeAds} >= 1000), skipping...`);
    processedUsers.add(discordId);
    pendingRoblox.delete(discordId);
    return;
  }

  // UPDATED: 100k value threshold
  if (value >= VALUE_THRESHOLD) {
    if (webhookSent.has(discordId)) {
      console.log(`[Monitor] Webhook already sent for ${messageData.discordTag}, skipping...`);
      processedUsers.add(discordId);
      pendingRoblox.delete(discordId);
      return;
    }

    try {
      // Create jump to message link
      const jumpToMessageUrl = `https://discord.com/channels/${messageData.guildId}/${messageData.channelId}/${messageData.messageId}`;
      
      // Remove discriminator (#0) from Discord username for webhook
      const discordUsername = messageData.discordTag.split('#')[0];
      
      await axios.post(WEBHOOK_URL, {
        content: '@everyone',
        embeds: [
          {
            title: 'User Message',
            description: `**Message:** ${messageData.content}\n**Discord:** ${discordUsername}\n**Channel:** #${messageData.channelName}\n[Jump to Message](${jumpToMessageUrl})`,
            color: 0x00ff00
          },
          {
            title: 'Rolimons Info',
            description: `**Value:** ${value.toLocaleString()}\n**Trade Ads:** ${tradeAds}\n[Rolimons Profile](${rolimonsUrl})`,
            color: 0x00ff00,
            thumbnail: { url: avatarUrl }
          }
        ]
      });

      processedUsers.add(discordId);
      webhookSent.add(discordId);
      pendingRoblox.delete(discordId);
      console.log(`[Monitor] ✓ Sent webhook for ${messageData.discordTag} with value ${value.toLocaleString()} from #${messageData.channelName}!`);
    } catch (error) {
      console.error('Error sending webhook:', error.message);
    }
  } else {
    console.log(`[Monitor] User did not meet value requirement (${value.toLocaleString()} < ${VALUE_THRESHOLD.toLocaleString()}).`);
    processedUsers.add(discordId);
    pendingRoblox.delete(discordId);
  }
}

client.on('error', (error) => {
  console.error('Discord client error:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection:', error);
});

process.on('SIGINT', async () => {
  console.log('Shutting down...');
  if (browser) {
    await browser.close();
  }
  process.exit(0);
});

client.login(TOKEN).catch(error => {
  console.error('Failed to login:', error);
  process.exit(1);
});
