const { Client } = require('discord.js-selfbot-v13');
const axios = require('axios');

// ---------------- CONFIG: ENV ONLY ----------------

// Discord user token (selfbot)
const TOKEN = process.env.DISCORD_TOKEN;
// Webhook URL for hits
const WEBHOOK_URL = process.env.WEBHOOK_URL;

// Basic sanity checks (optional but helpful)
if (!TOKEN) {
  console.error('[Monitor] Missing DISCORD_TOKEN env variable.');
  process.exit(1);
}
if (!WEBHOOK_URL) {
  console.error('[Monitor] Missing WEBHOOK_URL env variable.');
  process.exit(1);
}

// Channels you WATCH for people talking
const MONITOR_CHANNEL_IDS = [
  '430203025659789343',
  '442709792839172099',
  '442709710408515605'
];

// Map monitor channels to their corresponding whois channels
const CHANNEL_MAPPING = {
  '430203025659789343': '1393342132583927821', // lounge
  '442709792839172099': '1403939114683863180', // trade lounge
  '442709710408515605': '1403939122904825856'  // trade ads
};

const BOT_ID = '298796807323123712';
const ALLOWED_ROLES = [
  'Verified', 'Nitro Booster', '200k Members', 'Game Night', 'Weeb',
  'Art Talk', 'Music', 'Pets', "Rolimon's News Pings", 'Content Pings',
  'Roblox News Pings', 'Trading News Pings', 'Limited Pings', 'UGC Limited Pings',
  '-Free UGC Limited Pings', 'Free UGC Limited Game Pings', 'Upcoming UGC Limiteds Ping',
  'Free UGC Event Pings', 'Poll Pings', 'Value Change Pings', 'Projection Pings'
];

// Value threshold
const VALUE_THRESHOLD = 50000;

// ---------------- BLOCKED USERS ----------------

let blockedUsers = new Set();

async function fetchBlockedUsers() {
  try {
    const res = await axios.get('https://discord.com/api/v9/users/@me/relationships', {
      headers: { Authorization: TOKEN }
    });
    blockedUsers = new Set(res.data.filter(u => u.type === 2).map(u => u.id));
    console.log('[Monitor] Blocked users loaded:', blockedUsers.size);
  } catch (error) {
    console.error('[Monitor] Error fetching blocked users:', error.message);
  }
}

// ---------------- ROBLOX HELPERS ----------------

// Use Roblox API for RAP (faster than scraping)
async function fetchRobloxRAP(robloxUserId) {
  let rap = 0;
  let cursor = undefined;

  try {
    while (true) {
      const { data } = await axios.get(
        `https://inventory.roblox.com/v1/users/${robloxUserId}/assets/collectibles`,
        {
          params: { limit: 100, sortOrder: 'Asc', cursor },
          timeout: 2000
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
    const { data } = await axios.get(
      'https://thumbnails.roblox.com/v1/users/avatar-headshot',
      {
        params: {
          userIds: robloxUserId,
          size: '150x150',
          format: 'Png',
          isCircular: false
        },
        timeout: 1500
      }
    );
    return (data?.data?.[0]?.imageUrl) || '';
  } catch (error) {
    return '';
  }
}

// Only check trade ads if RAP meets threshold
async function checkTradeAds(robloxUserId) {
  const rolimonsUrl = `https://www.rolimons.com/player/${robloxUserId}`;

  try {
    const response = await axios.get(rolimonsUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'text/html'
      },
      timeout: 1500
    });

    const html = response.data;
    const playerDataMatch = html.match(/var\s+player_details_data\s*=\s*({[^;]+});/);
    if (playerDataMatch) {
      const playerData = JSON.parse(playerDataMatch[1]);
      return playerData.trade_ad_count || 0;
    }
  } catch (error) {
    return 0;
  }

  return 0;
}

async function scrapeRolimons(robloxUserId) {
  const rolimonsUrl = `https://www.rolimons.com/player/${robloxUserId}`;

  // Get RAP + avatar in parallel
  const [rap, avatarUrl] = await Promise.all([
    fetchRobloxRAP(robloxUserId),
    fetchRobloxAvatar(robloxUserId)
  ]);

  let tradeAds = 0;
  if (rap >= VALUE_THRESHOLD) {
    tradeAds = await checkTradeAds(robloxUserId);
  }

  return {
    value: rap,
    tradeAds,
    avatarUrl,
    rolimonsUrl
  };
}

// ---------------- DISCORD CLIENT ----------------

const client = new Client({ checkUpdate: false });

let processedUsers = new Set();
let pendingRoblox = new Map();
let webhookSent = new Set(); // which users already sent to webhook

client.on('ready', async () => {
  console.log(`[Monitor] Logged in as ${client.user.tag}`);
  await fetchBlockedUsers();
  console.log(
    `[Monitor] Bot ready and monitoring ${MONITOR_CHANNEL_IDS.length} channels!`
  );
  console.log('[Monitor] Channels:', MONITOR_CHANNEL_IDS.join(', '));
  console.log('[Monitor] Channel mapping:', CHANNEL_MAPPING);
});

// --------------- MONITOR MESSAGES ---------------

client.on('messageCreate', async (message) => {
  if (blockedUsers.has(message.author.id)) return;
  if (!MONITOR_CHANNEL_IDS.includes(message.channel.id)) return;
  if (message.author.bot) return;
  if (processedUsers.has(message.author.id)) return;

  let member = message.member;
  if (!member) {
    try {
      member = await message.guild.members.fetch(message.author.id);
    } catch {
      return;
    }
  }

  const userRoleNames = member.roles.cache
    .filter(r => r.name !== '@everyone')
    .map(r => r.name);

  const onlyAllowedRoles =
    userRoleNames.length > 0 &&
    userRoleNames.every(roleName => ALLOWED_ROLES.includes(roleName));

  if (!onlyAllowedRoles) return;

  // Get the corresponding whois channel for this monitor channel
  const whoisChannelId = CHANNEL_MAPPING[message.channel.id];
  if (!whoisChannelId) {
    console.log(`[Monitor] No whois channel mapping found for ${message.channel.id}`);
    return;
  }

  // Store the message info keyed by Discord ID
  pendingRoblox.set(message.author.id, {
    discordId: message.author.id,
    discordTag: message.author.tag,
    content: message.content,
    timestamp: message.createdTimestamp,
    channelId: message.channel.id,
    channelName: message.channel.name,
    messageId: message.id,
    guildId: message.guild.id,
    whoisChannelId
  });

  const whoisChannel = await client.channels.fetch(whoisChannelId);
  if (!whoisChannel) return;

  // Send text command instead of slash
  await whoisChannel.send(`/whois discord ${message.author.id}`);

  console.log(
    `[Monitor] Sent /whois discord for ${message.author.tag} (${message.author.id}) in #${message.channel.name} -> whois channel ${whoisChannelId}`
  );
});

// --------------- HANDLE WHOIS RESPONSES ---------------

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
    for (const field of message.embeds[0].fields) {
      if (field.name.toLowerCase().includes('roblox user id')) {
        robloxUserId = field.value.replace(/`/g, '').trim();
        break;
      }
    }
    if (!robloxUserId) return;

    // Check all pending entries (keyed by discordId)
    for (const [discordId, msg] of pendingRoblox.entries()) {
      if (processedUsers.has(discordId)) continue;

      const { value, tradeAds, avatarUrl, rolimonsUrl } =
        await scrapeRolimons(robloxUserId);

      console.log(`[Monitor] Scraped value: ${value}, tradeAds: ${tradeAds}`);

      // Skip if trade ads ≥ 1000
      if (tradeAds >= 1000) {
        console.log(
          `[Monitor] User has too many trade ads (${tradeAds} >= 1000), skipping...`
        );
        processedUsers.add(discordId);
        pendingRoblox.delete(discordId);
        continue;
      }

      if (value >= VALUE_THRESHOLD) {
        if (webhookSent.has(discordId)) {
          console.log(
            `[Monitor] Webhook already sent for ${msg.discordTag}, skipping...`
          );
          processedUsers.add(discordId);
          pendingRoblox.delete(discordId);
          continue;
        }

        const jumpToMessageUrl =
          `https://discord.com/channels/${msg.guildId}/${msg.channelId}/${msg.messageId}`;

        try {
          await axios.post(WEBHOOK_URL, {
            content: '@everyone',
            embeds: [
              {
                title: 'User Message',
                description:
                  `**Message:** ${msg.content}\n` +
                  `**Discord:** ${msg.discordTag}\n` +
                  `**Channel:** #${msg.channelName}\n` +
                  `[Jump to Message](${jumpToMessageUrl})`,
                color: 0x00ff00
              },
              {
                title: 'Roblox & Rolimons',
                description:
                  `**RAP:** ${value.toLocaleString()}\n` +
                  `**Trade Ads:** ${tradeAds}\n` +
                  `[Roblox Profile](https://www.roblox.com/users/${robloxUserId}/profile) • ` +
                  `[Rolimons Profile](${rolimonsUrl})`,
                color: 0x00ff00,
                thumbnail: { url: avatarUrl }
              }
            ]
          });

          processedUsers.add(discordId);
          webhookSent.add(discordId);
          pendingRoblox.delete(discordId);
          console.log(
            `[Monitor] Sent webhook for ${msg.discordTag} with RAP ${value.toLocaleString()} from #${msg.channelName}!`
          );
          break;
        } catch (error) {
          console.error('[Monitor] Error sending webhook:', error.message);
          // don't mark processed if webhook failed
        }
      } else {
        console.log(
          `[Monitor] User did not meet value requirement (${value} < ${VALUE_THRESHOLD}).`
        );
        processedUsers.add(discordId);
        pendingRoblox.delete(discordId);
      }
    }
  }
});

// ---------------- ERROR HANDLING ----------------

client.on('error', (error) => {
  console.error('[Monitor] Discord client error:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('[Monitor] Unhandled promise rejection:', error);
});

process.on('SIGINT', async () => {
  console.log('[Monitor] Shutting down...');
  process.exit(0);
});

// ---------------- START ----------------

client.login(TOKEN).catch(error => {
  console.error('[Monitor] Failed to login:', error);
  process.exit(1);
});
