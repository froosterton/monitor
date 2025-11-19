const { Client } = require('discord.js-selfbot-v13');
const axios = require('axios');
// Use environment variable for token (more secure)
const TOKEN = process.env.DISCORD_TOKEN
const MONITOR_CHANNEL_IDS = [
  '430203025659789343', 
  '442709792839172099', 
  '442709710408515605',
  '749645946719174757',  // New channel 1
  '808540135666745345'   // New channel 2
];

// Map monitor channels to their corresponding whois channels
const CHANNEL_MAPPING = {
  '430203025659789343': '1393342132583927821', // lounge
  '442709792839172099': '1403939114683863180', // trade lounge
  '442709710408515605': '1403939122904825856', // trade ads
  '749645946719174757': '1393342132583927821', // New channel 1 whois (using existing channel)
  '808540135666745345': '1393342132583927821'  // New channel 2 whois (using existing channel)
};

// Guilds where role filtering should be skipped
const SKIP_ROLE_FILTER_GUILDS = [
  '786851062219931690', // Guild for channel 808540135666745345
  '749629643836882975'  // Guild for channel 749645946719174757
];

const WEBHOOK_URL = 'https://discord.com/api/webhooks/1403167152751513642/Hm5U3_t_D8VYMN9Q3qUXnhzKGSeM2F-f3CyKVdedbH_k9BDPHYPGAsewO24FXepjIUzm';
const BOT_ID = '298796807323123712';
const ALLOWED_ROLES = [
  "Verified", "Nitro Booster", "200k Members", "Game Night", "Weeb",
  "Art Talk", "Music", "Pets", "Rolimon's News Pings", "Content Pings",
  "Roblox News Pings", "Trading News Pings", "Limited Pings", "UGC Limited Pings",
  "-Free UGC Limited Pings", "Free UGC Limited Game Pings", "Upcoming UGC Limiteds Ping",
  "Free UGC Event Pings", "Poll Pings", "Value Change Pings", "Projection Pings"
];
const RAP_THRESHOLD = 50000;

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

async function fetchUserRAP(robloxUserId) {
  let rap = 0;
  let cursor;

  try {
    while (true) {
      const { data } = await axios.get(
        `https://inventory.roblox.com/v1/users/${robloxUserId}/assets/collectibles`,
        { params: { limit: 100, sortOrder: 'Asc', cursor } }
      );

      const collectibles = Array.isArray(data?.data) ? data.data : [];
      if (collectibles.length === 0) break;

      for (const collectible of collectibles) {
        rap += Number(collectible.recentAveragePrice || 0);
      }

      if (data?.nextPageCursor) {
        cursor = data.nextPageCursor;
      } else {
        break;
      }
    }
  } catch (error) {
    console.error(`[Monitor] Failed to fetch RAP for ${robloxUserId}:`, error.message);
  }

  return rap;
}

async function fetchAvatarUrl(robloxUserId) {
  try {
    const { data } = await axios.get('https://thumbnails.roblox.com/v1/users/avatar-headshot', {
      params: { userIds: robloxUserId, size: '150x150', format: 'Png', isCircular: false }
    });

    return data?.data?.[0]?.imageUrl || '';
  } catch (error) {
    console.error(`[Monitor] Failed to fetch avatar for ${robloxUserId}:`, error.message);
    return '';
  }
}

function robloxProfileUrl(robloxUserId) {
  return `https://www.roblox.com/users/${robloxUserId}/profile`;
}

function rolimonsProfileUrl(robloxUserId) {
  return `https://www.rolimons.com/player/${robloxUserId}`;
}

const client = new Client({ checkUpdate: false });

let processedUsers = new Set(); // Users we've already processed completely
let pendingRoblox = new Map(); // Users waiting for Roblox ID lookup
let webhookSent = new Set(); // Users we've already sent webhooks for
let lookupAttempted = new Set(); // Users we've already tried to look up (prevents duplicate lookups)

client.on('ready', async () => {
  console.log(`[Monitor] Logged in as ${client.user.tag}`);
  await fetchBlockedUsers();
  console.log(`[Monitor] Bot ready and monitoring ${MONITOR_CHANNEL_IDS.length} channels!`);
  console.log(`[Monitor] Channels: ${MONITOR_CHANNEL_IDS.join(', ')}`);
  console.log(`[Monitor] Channel mapping:`, CHANNEL_MAPPING);
});

client.on('messageCreate', async (message) => {
  if (blockedUsers.has(message.author.id)) return;
  if (!MONITOR_CHANNEL_IDS.includes(message.channel.id)) return;
  if (message.author.bot) return;
  if (processedUsers.has(message.author.id)) return;
  if (lookupAttempted.has(message.author.id)) return; // Don't lookup the same user twice

  let member = message.member;
  if (!member) {
    try {
      member = await message.guild.members.fetch(message.author.id);
    } catch {
      return;
    }
  }

  // Check if role filtering should be applied based on guild
  const shouldApplyRoleFilter = !SKIP_ROLE_FILTER_GUILDS.includes(message.guild.id);
  
  if (shouldApplyRoleFilter) {
    // Apply role filtering only for guild 415246288779608064 and other guilds not in skip list
    const userRoleNames = member.roles.cache.filter(r => r.name !== '@everyone').map(r => r.name);
    const onlyAllowedRoles = userRoleNames.length > 0 && userRoleNames.every(roleName => ALLOWED_ROLES.includes(roleName));
    if (!onlyAllowedRoles) return;
  } else {
    console.log(`[Monitor] Skipping role filter for guild ${message.guild.id} (${message.guild.name})`);
  }

  // Get the corresponding whois channel for this monitor channel
  const whoisChannelId = CHANNEL_MAPPING[message.channel.id];
  if (!whoisChannelId) {
    console.log(`[Monitor] No whois channel mapping found for ${message.channel.id}`);
    return;
  }

  // Mark this user as lookup attempted to prevent duplicate lookups
  lookupAttempted.add(message.author.id);

  // Create message URL for "Jump To Message" feature
  const messageUrl = `https://discord.com/channels/${message.guild.id}/${message.channel.id}/${message.id}`;

  // Store the message info keyed by Discord ID (for now)
  pendingRoblox.set(message.author.id, {
    discordId: message.author.id,
    discordTag: message.author.tag,
    content: message.content,
    timestamp: message.createdTimestamp,
    channelId: message.channel.id,
    channelName: message.channel.name,
    whoisChannelId: whoisChannelId,
    messageUrl: messageUrl  // Added: Store message URL
  });
  
  const whoisChannel = await client.channels.fetch(whoisChannelId);
  if (!whoisChannel) return;
  
  try {
    await whoisChannel.sendSlash(BOT_ID, 'whois discord', message.author.id);
    console.log(`[Monitor] Sent /whois discord for ${message.author.tag} (${message.author.id}) in #${message.channel.name} -> whois channel ${whoisChannelId}`);
  } catch (error) {
    console.error(`[Monitor] Failed to send /whois command:`, error.message);
    pendingRoblox.delete(message.author.id);
    lookupAttempted.delete(message.author.id);
  }
});

// Listen for bot responses globally
client.on('messageCreate', async (message) => {
  // Check if this is a bot response in any of our whois channels
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

      // Find the pending request that matches this Roblox user ID
      // We check all pending entries because we key by Discord ID
      for (const [discordId, msg] of pendingRoblox.entries()) {
        if (processedUsers.has(discordId)) continue;

        // Fetch RAP and avatar using Roblox APIs
        const rap = await fetchUserRAP(robloxUserId);
        const avatarUrl = await fetchAvatarUrl(robloxUserId);
        const robloxUrl = robloxProfileUrl(robloxUserId);
        const rolimonsUrl = rolimonsProfileUrl(robloxUserId);
        console.log(`[Monitor] Computed RAP: ${rap}`);
        
        if (rap >= RAP_THRESHOLD) {
          // Check if we've already sent a webhook for this user
          if (webhookSent.has(discordId)) {
            console.log(`[Monitor] Webhook already sent for ${msg.discordTag}, skipping...`);
            processedUsers.add(discordId);
            pendingRoblox.delete(discordId);
            continue;
          }
          
          try {
            await axios.post(WEBHOOK_URL, {
              content: '@everyone',
              embeds: [
                {
                  title: 'User Message',
                  description: `**Message:** ${msg.content}\n**Discord:** ${msg.discordTag}\n**Channel:** #${msg.channelName}\n\n[Jump To Message](${msg.messageUrl})`,  // Added: Jump To Message link
                  color: 0x00ff00
                },
                {
                  title: 'Roblox Info',
                  description: `**RAP:** ${rap.toLocaleString()}\n[Roblox Profile](${robloxUrl}) • [Rolimons Profile](${rolimonsUrl})`,
                  color: 0x00ff00,
                  thumbnail: { url: avatarUrl }
                }
              ]
            });
            
            // Mark this user as processed and webhook sent
            processedUsers.add(discordId);
            webhookSent.add(discordId);
            pendingRoblox.delete(discordId);
            console.log(`[Monitor] Sent webhook for ${msg.discordTag} with RAP ${rap} from #${msg.channelName}!`);
            break; // Only process the first match
          } catch (error) {
            console.error('Error sending webhook:', error.message);
            // Don't mark as processed if webhook failed
          }
        } else {
          console.log(`[Monitor] User did not meet RAP requirement (${rap} < ${RAP_THRESHOLD}).`);
          processedUsers.add(discordId);
          pendingRoblox.delete(discordId);
        }
      }
  }
});

// Error handling
client.on('error', (error) => {
  console.error('Discord client error:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection:', error);
});

process.on('SIGINT', () => {
  console.log('Shutting down...');
  process.exit(0);
});

// Start the bot
client.login(TOKEN).catch(error => {
  console.error('Failed to login:', error);
  process.exit(1);
});
