const { Client } = require('discord.js-selfbot-v13');
const axios = require('axios');

// ─── Config (env for secrets, everything else hardcoded) ──────────────
const TOKEN = process.env.DISCORD_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

const GUILD_ID = '1393342132583927818';

const MONITOR_CHANNEL_IDS = [
  '430203025659789343',  // lounge
  '442709792839172099',  // trade lounge
  '442709710408515605',  // trade ads
  '542147434122444838'   // bot cmds
];

// Map monitor channels to their corresponding whois channels (Rover)
const CHANNEL_MAPPING = {
  '430203025659789343': '1393342132583927821', // lounge
  '442709792839172099': '1403939114683863180', // trade lounge
  '442709710408515605': '1403939122904825856', // trade ads
  '542147434122444838': '1444771838600155300'  // bot cmds
};

// Bloxlink /getinfo always goes here
const BLOXLINK_CHANNEL_ID = '1471499501461176464';

// Bot IDs
const ROVER_BOT_ID = '298796807323123712';
const BLOXLINK_BOT_ID = '426537812993638400';

const ALLOWED_ROLES = [
  "Verified", "Rover Verified", "Nitro Booster", "200k Members", "Game Night", "Weeb",
  "Art Talk", "Music", "Pets", "Rolimon's News Pings", "Content Pings",
  "Roblox News Pings", "Trading News Pings", "Limited Pings", "UGC Limited Pings",
  "-Free UGC Limited Pings", "Free UGC Limited Game Pings", "Upcoming UGC Limiteds Ping",
  "Free UGC Event Pings", "Poll Pings", "Value Change Pings", "Projection Pings"
];

// Value threshold
const VALUE_THRESHOLD = 50000;

// ─── Command cache (loaded from guild on startup) ─────────────────────
let roverWhoisCmd = null;
let bloxlinkGetinfoCmd = null;

// ─── Nonce generator ──────────────────────────────────────────────────
function generateNonce() {
  return String(BigInt(Date.now() - 1420070400000) << 22n | BigInt(Math.floor(Math.random() * 4194304)));
}

// ─── Raw interaction senders (bypasses broken searchInteraction) ──────
async function sendRoverWhois(channelId, userId) {
  if (!roverWhoisCmd) throw new Error('Rover /whois command not loaded');
  const payload = {
    type: 2,
    application_id: ROVER_BOT_ID,
    guild_id: GUILD_ID,
    channel_id: channelId,
    session_id: client.ws?.shards?.first()?.sessionId || '',
    data: {
      version: roverWhoisCmd.version,
      id: roverWhoisCmd.id,
      name: 'whois',
      type: 1,
      options: [{
        type: 1,
        name: 'discord',
        options: [{
          type: 6,
          name: 'user',
          value: userId
        }]
      }]
    },
    nonce: generateNonce()
  };
  const res = await fetch('https://discord.com/api/v9/interactions', {
    method: 'POST',
    headers: { 'Authorization': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (res.status !== 204) throw new Error(`Rover interaction failed: ${res.status}`);
}

async function sendBloxlinkGetinfo(channelId, userId) {
  if (!bloxlinkGetinfoCmd) throw new Error('Bloxlink /getinfo command not loaded');
  const payload = {
    type: 2,
    application_id: BLOXLINK_BOT_ID,
    guild_id: GUILD_ID,
    channel_id: channelId,
    session_id: client.ws?.shards?.first()?.sessionId || '',
    data: {
      version: bloxlinkGetinfoCmd.version,
      id: bloxlinkGetinfoCmd.id,
      name: 'getinfo',
      type: 1,
      options: [{
        type: 6,
        name: 'discord_user',
        value: userId
      }]
    },
    nonce: generateNonce()
  };
  const res = await fetch('https://discord.com/api/v9/interactions', {
    method: 'POST',
    headers: { 'Authorization': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (res.status !== 204) throw new Error(`Bloxlink interaction failed: ${res.status}`);
}

// ─── Roblox API helpers ───────────────────────────────────────────────
async function fetchRobloxRAP(robloxUserId) {
  let rap = 0;
  let cursor = undefined;
  try {
    while (true) {
      const { data } = await axios.get(
        `https://inventory.roblox.com/v1/users/${robloxUserId}/assets/collectibles`,
        { params: { limit: 100, sortOrder: 'Asc', cursor }, timeout: 2000 }
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
      timeout: 1500
    });
    return (data?.data?.[0]?.imageUrl) || '';
  } catch {
    return '';
  }
}

async function scrapeRolimons(robloxUserId) {
  const rolimonsUrl = `https://www.rolimons.com/player/${robloxUserId}`;
  const [rap, avatarUrl] = await Promise.all([
    fetchRobloxRAP(robloxUserId),
    fetchRobloxAvatar(robloxUserId)
  ]);
  return { value: rap, avatarUrl, rolimonsUrl };
}

// ─── Extract Roblox ID from bot responses ─────────────────────────────

// Rover: traditional embeds — field "Roblox User ID"
function extractFromEmbeds(message) {
  const embeds = message.embeds || [];
  if (embeds.length === 0) return null;
  for (const embed of embeds) {
    if (embed.fields) {
      for (const field of embed.fields) {
        if (field.name.toLowerCase().includes('roblox user id')) {
          const id = field.value.replace(/[`\s]/g, '').trim();
          if (/^\d+$/.test(id)) return id;
        }
      }
    }
    if (embed.title) {
      const m = embed.title.match(/\((\d+)\)/);
      if (m) return m[1];
    }
    if (embed.url) {
      const m = embed.url.match(/roblox\.com\/users\/(\d+)/);
      if (m) return m[1];
    }
  }
  return null;
}

// Bloxlink: Components V2 — Roblox ID in nested component content
// e.g. "### [PrairieFerret](https://www.roblox.com/users/10422120816/profile) (10422120816)"
function extractFromComponentsV2(rawComponents) {
  if (!rawComponents || !Array.isArray(rawComponents)) return null;
  function searchComponents(components) {
    for (const comp of components) {
      if (comp.type === 10 && comp.content) {
        const urlMatch = comp.content.match(/roblox\.com\/users\/(\d+)/);
        if (urlMatch) return urlMatch[1];
        const idMatch = comp.content.match(/\((\d+)\)/);
        if (idMatch && idMatch[1].length >= 5) return idMatch[1];
      }
      if (comp.components) {
        const found = searchComponents(comp.components);
        if (found) return found;
      }
    }
    return null;
  }
  return searchComponents(rawComponents);
}

// Fetch recent messages from channel (user token compatible)
async function fetchRawMessages(channelId, limit = 5) {
  const res = await fetch(`https://discord.com/api/v9/channels/${channelId}/messages?limit=${limit}`, {
    headers: { 'Authorization': TOKEN }
  });
  if (!res.ok) return [];
  return await res.json();
}

// ─── Client setup ─────────────────────────────────────────────────────
const client = new Client({ checkUpdate: false });

let processedUsers = new Set();
let pendingRoblox = new Map();
let webhookSent = new Set();
let processedBotMessages = new Set();

client.on('ready', async () => {
  console.log(`[Monitor] Logged in as ${client.user.tag}`);

  // Load command data from guild command index (replaces broken searchInteraction)
  console.log('[Monitor] Fetching guild command index...');
  try {
    const res = await fetch(`https://discord.com/api/v9/guilds/${GUILD_ID}/application-command-index`, {
      headers: { 'Authorization': TOKEN }
    });
    const data = await res.json();

    roverWhoisCmd = data.application_commands?.find(c => c.name === 'whois' && c.application_id === ROVER_BOT_ID);
    bloxlinkGetinfoCmd = data.application_commands?.find(c => c.name === 'getinfo' && c.application_id === BLOXLINK_BOT_ID);

    console.log(`[Monitor] Rover /whois: ${roverWhoisCmd ? 'LOADED' : 'NOT FOUND'}`);
    console.log(`[Monitor] Bloxlink /getinfo: ${bloxlinkGetinfoCmd ? 'LOADED' : 'NOT FOUND'}`);
  } catch (err) {
    console.error('[Monitor] Failed to fetch command index:', err.message);
  }

  console.log(`[Monitor] Bot ready and monitoring ${MONITOR_CHANNEL_IDS.length} channels!`);
  console.log(`[Monitor] Channels: ${MONITOR_CHANNEL_IDS.join(', ')}`);
  console.log(`[Monitor] Rover Verified -> /whois discord | Verified -> /getinfo discord_user`);
  console.log(`[Monitor] Channel mapping:`, CHANNEL_MAPPING);
});

// ─── Monitor messages in target channels ──────────────────────────────
client.on('messageCreate', async (message) => {
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

  const userRoleNames = member.roles.cache.filter(r => r.name !== '@everyone').map(r => r.name);
  const onlyAllowedRoles = userRoleNames.length > 0 && userRoleNames.every(roleName => ALLOWED_ROLES.includes(roleName));
  if (!onlyAllowedRoles) return;

  // Determine which bot to use based on verification role
  const hasRoverVerified = userRoleNames.includes('Rover Verified');
  const hasVerified = userRoleNames.includes('Verified');
  if (!hasRoverVerified && !hasVerified) return;

  const whoisChannelId = CHANNEL_MAPPING[message.channel.id];
  if (!whoisChannelId) {
    console.log(`[Monitor] No whois channel mapping found for ${message.channel.id}`);
    return;
  }

  const botUsed = hasRoverVerified ? 'rover' : 'bloxlink';
  const targetChannelId = botUsed === 'bloxlink' ? BLOXLINK_CHANNEL_ID : whoisChannelId;

  // Mark as processed IMMEDIATELY to prevent duplicate triggers
  processedUsers.add(message.author.id);

  // Store the message info
  pendingRoblox.set(message.author.id, {
    discordId: message.author.id,
    discordTag: message.author.tag,
    content: message.content,
    timestamp: message.createdTimestamp,
    channelId: message.channel.id,
    channelName: message.channel.name,
    messageId: message.id,
    guildId: message.guild.id,
    whoisChannelId: targetChannelId,
    botUsed
  });

  try {
    if (botUsed === 'rover') {
      await sendRoverWhois(targetChannelId, message.author.id);
      console.log(`[Monitor] Sent Rover /whois for ${message.author.tag} (${message.author.id}) in #${message.channel.name} -> whois channel ${targetChannelId}`);
    } else {
      await sendBloxlinkGetinfo(BLOXLINK_CHANNEL_ID, message.author.id);
      console.log(`[Monitor] Sent Bloxlink /getinfo for ${message.author.tag} (${message.author.id}) in #${message.channel.name} -> blox channel ${BLOXLINK_CHANNEL_ID}`);
    }
  } catch (err) {
    console.error(`[Monitor] Failed to send command for ${message.author.tag}: ${err.message}`);
    pendingRoblox.delete(message.author.id);
  }
});

// ─── Listen for bot responses (Rover + Bloxlink) ─────────────────────
// Rover: traditional embeds via messageCreate
// Bloxlink: Components V2 via messageUpdate (deferred response)

async function handleBotResponse(message, isUpdate) {
  const watchedChannels = [...Object.values(CHANNEL_MAPPING), BLOXLINK_CHANNEL_ID];
  if (!watchedChannels.includes(message.channel.id)) return;
  if (message.author.id !== ROVER_BOT_ID && message.author.id !== BLOXLINK_BOT_ID) return;

  // Skip already-processed bot responses
  if (processedBotMessages.has(message.id)) return;

  const respondingBot = message.author.id === ROVER_BOT_ID ? 'rover' : 'bloxlink';
  let robloxUserId = null;

  if (respondingBot === 'rover') {
    // Rover: try traditional embeds first
    robloxUserId = extractFromEmbeds(message);
    if (!robloxUserId && isUpdate) {
      // Fallback: fetch raw and check components/embeds
      await new Promise(r => setTimeout(r, 500));
      const rawMsgs = await fetchRawMessages(message.channel.id, 3);
      const raw = rawMsgs.find(m => m.id === message.id);
      if (raw) {
        robloxUserId = extractFromEmbeds({ embeds: raw.embeds || [] }) || extractFromComponentsV2(raw.components);
      }
    }
  } else {
    // Bloxlink: Components V2, only process on update (deferred response)
    if (!isUpdate) return;
    await new Promise(r => setTimeout(r, 1000));
    const rawMsgs = await fetchRawMessages(BLOXLINK_CHANNEL_ID, 3);
    const raw = rawMsgs.find(m => m.id === message.id);
    if (raw) {
      robloxUserId = extractFromComponentsV2(raw.components);
    }
  }

  if (!robloxUserId) return;

  // Mark this bot response as handled
  processedBotMessages.add(message.id);

  // Find the pending request that matches
  for (const [discordId, msg] of pendingRoblox.entries()) {
    if (webhookSent.has(discordId)) continue;
    if (msg.whoisChannelId !== message.channel.id) continue;
    if (msg.botUsed !== respondingBot) continue;

    // Scrape Rolimons and check value
    const { value, avatarUrl, rolimonsUrl } = await scrapeRolimons(robloxUserId);
    console.log(`[Monitor] ${respondingBot === 'rover' ? 'Rover' : 'Bloxlink'} returned Roblox ID ${robloxUserId} | RAP: ${value.toLocaleString()}`);

    if (value >= VALUE_THRESHOLD) {
      if (webhookSent.has(discordId)) {
        console.log(`[Monitor] Webhook already sent for ${msg.discordTag}, skipping...`);
        pendingRoblox.delete(discordId);
        continue;
      }

      const jumpToMessageUrl = `https://discord.com/channels/${msg.guildId}/${msg.channelId}/${msg.messageId}`;
      const verifiedVia = respondingBot === 'rover' ? 'Rover Verified' : 'Bloxlink Verified';

      try {
        await axios.post(WEBHOOK_URL, {
          content: '@everyone',
          embeds: [
            {
              title: 'User Message',
              description: `**Message:** ${msg.content}\n**Discord:** ${msg.discordTag}\n**Channel:** #${msg.channelName}\n**Verified via:** ${verifiedVia}\n[Jump to Message](${jumpToMessageUrl})`,
              color: 0x00ff00
            },
            {
              title: 'Roblox & Rolimons',
              description: `**RAP:** ${value.toLocaleString()}\n[Roblox Profile](https://www.roblox.com/users/${robloxUserId}/profile) • [Rolimons Profile](${rolimonsUrl})`,
              color: 0x00ff00,
              thumbnail: { url: avatarUrl }
            }
          ]
        });

        webhookSent.add(discordId);
        pendingRoblox.delete(discordId);
        console.log(`[Monitor] Sent webhook for ${msg.discordTag} with RAP ${value.toLocaleString()} from #${msg.channelName} (${verifiedVia})!`);
        break;
      } catch (error) {
        console.error('Error sending webhook:', error.message);
      }
    } else {
      console.log(`[Monitor] User did not meet value requirement (${value} < ${VALUE_THRESHOLD}).`);
      pendingRoblox.delete(discordId);
    }
  }
}

client.on('messageCreate', (msg) => handleBotResponse(msg, false));
client.on('messageUpdate', (_, msg) => handleBotResponse(msg, true));

// ─── Error handling ───────────────────────────────────────────────────
client.on('error', (error) => {
  console.error('Discord client error:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection:', error);
});

process.on('SIGINT', async () => {
  console.log('Shutting down...');
  process.exit(0);
});

// ─── Start ────────────────────────────────────────────────────────────
client.login(TOKEN).catch(error => {
  console.error('Failed to login:', error);
  process.exit(1);
});
