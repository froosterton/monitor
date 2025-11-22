const { Client } = require('discord.js-selfbot-v13');
const axios = require('axios');
const fs = require('fs');

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

// RoVer bot / application id
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

// ---------------- PERSISTENT CHECKED USERS (Railway Volume) ----------------

// This path is inside the Railway Volume mounted at /data
// Make sure the Volume mount path in Railway is /data
const CHECKED_FILE = '/data/checked_users.json';

let checkedUsers = new Set();   // survives restarts via file

function loadCheckedUsers() {
  try {
    if (fs.existsSync(CHECKED_FILE)) {
      const arr = JSON.parse(fs.readFileSync(CHECKED_FILE, 'utf8'));
      if (Array.isArray(arr)) {
        checkedUsers = new Set(arr);
      }
    }
    console.log(`[Monitor] Loaded checked users: ${checkedUsers.size}`);
  } catch (err) {
    console.error('[Monitor] Failed to load checked users:', err.message);
  }
}

function saveCheckedUsers() {
  try {
    fs.writeFileSync(CHECKED_FILE, JSON.stringify([...checkedUsers]), 'utf8');
  } catch (err) {
    console.error('[Monitor] Failed to save checked users:', err.message);
  }
}

// ---------------- RUNTIME STATE (per process) ----------------

let blockedUsers = new Set();    // from Discord relationships
let processedUsers = new Set();  // processed in this run
let pendingRoblox = new Map();   // discordId -> meta
let webhookSent = new Set();     // to avoid duplicates in this run

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
  } catch {
    // ignore RAP errors, treat as 0
  }

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
  } catch {
    // ignore
  }

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
  loadCheckedUsers();
  await fetchBlockedUsers();
  console.log(`[Monitor] Monitoring ${MONITOR_CHANNEL_IDS.length} channels`);
});

// global safety so nothing kills the process silently
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

// helper: send /whois safely
async function sendWhoisForMessage(message, whoisChannelId) {
  const whoisChannel = await client.channels.fetch(whoisChannelId).catch(() => null);
  if (!whoisChannel) return false;

  try {
    await whoisChannel.sendSlash(BOT_ID, "whois discord", message.author.id);
    console.log(`[Monitor] /whois sent for ${message.author.tag}`);
    return true;
  } catch (err) {
    const msg = String(err?.message || '');
    console.error(`[Monitor] Failed to send /whois for ${message.author.tag}:`, msg);

    if (
      msg.includes('INTERACTION_TIMEOUT') ||
      msg.includes('botId is not a bot') ||
      msg.includes('application slash command')
    ) {
      console.error('[Monitor] RoVer / slash metadata issue. Skipping this user.');
    }

    return false;
  }
}

// mark a user as fully checked (and persist)
function markUserChecked(discordId) {
  processedUsers.add(discordId);
  checkedUsers.add(discordId);
  pendingRoblox.delete(discordId);
  saveCheckedUsers();
}

// ------------- MESSAGE HANDLER: WATCH MONITOR CHANNELS -------------

client.on('messageCreate', async (message) => {
  // skip if:
  // - bot
  // - blocked
  // - not in monitored channel
  // - already processed in this run
  // - already checked in any previous run (from file)
  if (
    message.author.bot ||
    blockedUsers.has(message.author.id) ||
    !MONITOR_CHANNEL_IDS.includes(message.channel.id) ||
    processedUsers.has(message.author.id) ||
    checkedUsers.has(message.author.id)
  ) {
    return;
  }

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

  const whoisChannelId = CHANNEL_MAPPING[message.channel.id];
  if (!whoisChannelId) return;

  // Only store pending if we actually sent the slash command
  const ok = await sendWhoisForMessage(message, whoisChannelId);
  if (!ok) return;

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
});

// ------------- MESSAGE HANDLER: LISTEN FOR ROVER WHOIS EMBEDS -------------
// THIS is the part that was wrong before and is now fixed.
client.on('messageCreate', async (message) => {
  const whoisChannels = Object.values(CHANNEL_MAPPING);

  if (
    message.author.id !== BOT_ID ||
    !whoisChannels.includes(message.channel.id) ||
    !message.embeds?.length
  ) {
    return;
  }

  const embed = message.embeds[0];
  if (!embed.fields || !embed.fields.length) return;

  // Extract Roblox ID
  let robloxUserId = '';
  for (const field of embed.fields) {
    if (field.name && field.name.toLowerCase().includes('roblox user id')) {
      robloxUserId = field.value.replace(/`/g, '').trim();
    }
  }
  if (!robloxUserId) return;

  // -------- NEW: find the exact Discord user this whois belongs to --------
  let targetDiscordId = null;

  // 1) If RoVer ever includes a mention in the description like <@123...>
  if (embed.description) {
    const m = embed.description.match(/<@!?(\d+)>/);
    if (m) targetDiscordId = m[1];
  }

  // 2) Or in any field values
  if (!targetDiscordId) {
    for (const field of embed.fields) {
      const m = field.value && field.value.match(/<@!?(\d+)>/);
      if (m) {
        targetDiscordId = m[1];
        break;
      }
    }
  }

  // 3) Fallback: match the embed’s top name (gl0limit#0, competitive#0, etc.)
  //    to the discordTag we stored when we sent /whois.
  if (!targetDiscordId && embed.author && embed.author.name) {
    for (const [discordId, data] of pendingRoblox.entries()) {
      if (data.discordTag === embed.author.name) {
        targetDiscordId = discordId;
        break;
      }
    }
  }

  if (!targetDiscordId) {
    // we couldn't match this whois to any pending user, so bail
    return;
  }

  const data = pendingRoblox.get(targetDiscordId);
  if (!data) return;
  if (processedUsers.has(targetDiscordId) || checkedUsers.has(targetDiscordId)) {
    return;
  }

  // Now we only process this ONE user, not every pending user.
  const { value, tradeAds, avatarUrl, rolimonsUrl } =
    await scrapeRolimons(robloxUserId);

  // Too many trade ads, mark as checked and skip
  if (tradeAds >= 1000) {
    markUserChecked(targetDiscordId);
    return;
  }

  if (value >= VALUE_THRESHOLD) {
    if (webhookSent.has(targetDiscordId)) {
      markUserChecked(targetDiscordId);
      return;
    }

    const jumpUrl = `https://discord.com/channels/${data.guildId}/${data.channelId}/${data.messageId}`;

    try {
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

      webhookSent.add(targetDiscordId);
      console.log(`[Monitor] Webhook sent for ${data.discordTag}`);
    } catch (err) {
      console.error('[Monitor] Failed to send webhook:', err.message);
    }

    markUserChecked(targetDiscordId);
    return;
  }

  // Low value, just mark as checked so we do not repeat later
  markUserChecked(targetDiscordId);
});

// Start bot
client.login(TOKEN);
