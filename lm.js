const { Client } = require('discord.js-selfbot-v13');
const axios = require('axios');

// ---------------- CONFIG (no hardcoded secrets) ----------------

const TOKEN = process.env.DISCORD_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

if (!TOKEN) {
  console.error("Missing DISCORD_TOKEN env variable.");
  process.exit(1);
}
if (!WEBHOOK_URL) {
  console.error("Missing WEBHOOK_URL env variable.");
  process.exit(1);
}

const MONITOR_CHANNEL_IDS = [
  '430203025659789343',
  '442709792839172099',
  '442709710408515605'
];

// Map monitor channels → whois channels
const CHANNEL_MAPPING = {
  '430203025659789343': '1393342132583927821',
  '442709792839172099': '1403939114683863180',
  '442709710408515605': '1403939122904825856'
};

const BOT_ID = '298796807323123712';

// Allowed roles
const ALLOWED_ROLES = [
  "Verified", "Nitro Booster", "200k Members", "Game Night", "Weeb",
  "Art Talk", "Music", "Pets", "Rolimon's News Pings", "Content Pings",
  "Roblox News Pings", "Trading News Pings", "Limited Pings", "UGC Limited Pings",
  "-Free UGC Limited Pings", "Free UGC Limited Game Pings", "Upcoming UGC Limiteds Ping",
  "Free UGC Event Pings", "Poll Pings", "Value Change Pings", "Projection Pings"
];

// Value threshold
const VALUE_THRESHOLD = 50000;

// Globals
let blockedUsers = new Set();
let processedUsers = new Set();
let pendingRoblox = new Map();
let webhookSent = new Set();

// ---------------- FETCH BLOCKED USERS ----------------

async function fetchBlockedUsers() {
  try {
    const res = await axios.get(
      'https://discord.com/api/v9/users/@me/relationships',
      {
        headers: { Authorization: TOKEN }
      }
    );

    blockedUsers = new Set(
      res.data.filter(u => u.type === 2).map(u => u.id)
    );

    console.log(`[Monitor] Blocked users loaded: ${blockedUsers.size}`);
  } catch (error) {
    console.error('Error fetching blocked users:', error.message);
  }
}

// ---------------- ROBLOX RAP + AVATAR + TRADE ADS ----------------

async function fetchRobloxRAP(userId) {
  let rap = 0;
  let cursor;

  try {
    while (true) {
      const { data } = await axios.get(
        `https://inventory.roblox.com/v1/users/${userId}/assets/collectibles`,
        {
          params: { limit: 100, sortOrder: 'Asc', cursor },
          timeout: 2000
        }
      );

      if (!data?.data?.length) break;

      for (const item of data.data) {
        rap += Number(item.recentAveragePrice || 0);
      }

      if (data.nextPageCursor) cursor = data.nextPageCursor;
      else break;
    }
  } catch {}

  return rap;
}

async function fetchRobloxAvatar(userId) {
  try {
    const { data } = await axios.get(
      'https://thumbnails.roblox.com/v1/users/avatar-headshot',
      {
        params: {
          userIds: userId,
          size: '150x150',
          format: 'Png',
          isCircular: false
        },
        timeout: 1500
      }
    );

    return data?.data?.[0]?.imageUrl || '';
  } catch {
    return '';
  }
}

async function checkTradeAds(userId) {
  const url = `https://www.rolimons.com/player/${userId}`;

  try {
    const res = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'text/html'
      },
      timeout: 1500
    });

    const html = res.data;
    const match = html.match(/var\s+player_details_data\s*=\s*({[^;]+});/);

    if (match) {
      const info = JSON.parse(match[1]);
      return info.trade_ad_count || 0;
    }
  } catch {}

  return 0;
}

async function scrapeRolimons(userId) {
  const [rap, avatarUrl] = await Promise.all([
    fetchRobloxRAP(userId),
    fetchRobloxAvatar(userId)
  ]);

  let tradeAds = 0;
  if (rap >= VALUE_THRESHOLD) {
    tradeAds = await checkTradeAds(userId);
  }

  return {
    value: rap,
    tradeAds,
    avatarUrl,
    rolimonsUrl: `https://www.rolimons.com/player/${userId}`
  };
}

// ---------------- DISCORD ----------------

const client = new Client({ checkUpdate: false });

client.on('ready', async () => {
  console.log(`[Monitor] Logged in as ${client.user.tag}`);
  await fetchBlockedUsers();
  console.log(`[Monitor] Monitoring ${MONITOR_CHANNEL_IDS.length} channels`);
});

// Watch monitored channels
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (blockedUsers.has(message.author.id)) return;
  if (!MONITOR_CHANNEL_IDS.includes(message.channel.id)) return;
  if (processedUsers.has(message.author.id)) return;

  // Role filter
  let member = message.member;
  if (!member) {
    try {
      member = await message.guild.members.fetch(message.author.id);
    } catch {
      return;
    }
  }

  const roles = member.roles.cache
    .filter(r => r.name !== '@everyone')
    .map(r => r.name);

  const valid = roles.length > 0 && roles.every(r => ALLOWED_ROLES.includes(r));
  if (!valid) return;

  // Map to whois channel
  const whoisChannelId = CHANNEL_MAPPING[message.channel.id];
  if (!whoisChannelId) return;

  // Store pending request
  pendingRoblox.set(message.author.id, {
    discordId: message.author.id,
    discordTag: message.author.tag,
    content: message.content,
    channelId: message.channel.id,
    channelName: message.channel.name,
    messageId: message.id,
    guildId: message.guild.id,
    whoisChannelId
  });

  const whoisChannel = await client.channels.fetch(whoisChannelId);
  if (!whoisChannel) return;

  whoisChannel.sendSlash(BOT_ID, "whois discord", message.author.id);

  console.log(`[Monitor] /whois sent for ${message.author.tag}`);
});

// Listen for whois responses
client.on('messageCreate', async (message) => {
  const whoisChannels = Object.values(CHANNEL_MAPPING);

  if (
    message.author.id !== BOT_ID ||
    !whoisChannels.includes(message.channel.id) ||
    !message.embeds?.length
  ) return;

  // Extract Roblox ID
  let robloxUserId = '';
  for (const field of message.embeds[0].fields) {
    if (field.name.toLowerCase().includes('roblox user id')) {
      robloxUserId = field.value.replace(/`/g, '').trim();
    }
  }
  if (!robloxUserId) return;

  // Find matching pending
  for (const [discordId, data] of pendingRoblox.entries()) {
    if (processedUsers.has(discordId)) continue;

    const { value, tradeAds, avatarUrl, rolimonsUrl } =
      await scrapeRolimons(robloxUserId);

    if (tradeAds >= 1000) {
      processedUsers.add(discordId);
      pendingRoblox.delete(discordId);
      continue;
    }

    if (value >= VALUE_THRESHOLD) {
      if (webhookSent.has(discordId)) {
        processedUsers.add(discordId);
        pendingRoblox.delete(discordId);
        continue;
      }

      const jumpUrl = `https://discord.com/channels/${data.guildId}/${data.channelId}/${data.messageId}`;

      // Send webhook
      await axios.post(WEBHOOK_URL, {
        content: '@everyone',
        embeds: [
          {
            title: "User Message",
            description:
              `**Message:** ${data.content}\n` +
              `**Discord:** ${data.discordTag}\n` +
              `**Discord ID:** ${data.discordId}\n` +
              `**Channel:** #${data.channelName}\n` +
              `[Jump to Message](${jumpUrl})`,
            color: 0x00ff00
          },
          {
            title: "Roblox & Rolimons",
            description:
              `**RAP:** ${value.toLocaleString()}\n` +
              `**Trade Ads:** ${tradeAds}\n` +
              `[Roblox Profile](https://www.roblox.com/users/${robloxUserId}/profile) • [Rolimons Profile](${rolimonsUrl})`,
            thumbnail: { url: avatarUrl },
            color: 0x00ff00
          }
        ]
      });

      webhookSent.add(discordId);
      processedUsers.add(discordId);
      pendingRoblox.delete(discordId);

      console.log(`[Monitor] Webhook sent for ${data.discordTag}`);
      break;
    }

    processedUsers.add(discordId);
    pendingRoblox.delete(discordId);
  }
});

// Start bot
client.login(TOKEN);