// monitor.js
const { Client } = require('discord.js-selfbot-v13');
const axios = require('axios');


// ---------------- CONFIG (env only) ----------------

const TOKEN = process.env.DISCORD_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

if (!TOKEN) {
  console.error('Missing DISCORD_TOKEN env variable.');
  process.exit(1);
}
if (!WEBHOOK_URL) {
  console.error('Missing WEBHOOK_URL env variable.');
  process.exit(1);
}

// Channels you WATCH for people talking
const MONITOR_CHANNEL_IDS = [
  '430203025659789343',
  '442709792839172099',
  '442709710408515605'
];

// Map monitor channels → whois log channels
const CHANNEL_MAPPING = {
  '430203025659789343': '1393342132583927821',
  '442709792839172099': '1403939114683863180',
  '442709710408515605': '1403939122904825856'
};

// RoVer bot / whois bot ID
const BOT_ID = '298796807323123712';

// track users you’ve already processed
const checkedUsers = new Set();

// ---------------- CLIENT SETUP ----------------

const client = new Client({ checkUpdate: false });

client.on('ready', () => {
  console.log(`[Monitor] Logged in as ${client.user.tag}`);
});

// ---------------- DEBUG: LOG ALL ROVER MESSAGES ----------------

client.on('messageCreate', (m) => {
  if (m.author.id === BOT_ID) {
    console.log(
      `[DEBUG RoVer] message in #${m.channel?.name || m.channelId} (${m.channelId})`
    );
    if (m.embeds?.length) {
      console.log(
        '[DEBUG RoVer] embed:',
        JSON.stringify(
          m.embeds[0].toJSON ? m.embeds[0].toJSON() : m.embeds[0],
          null,
          2
        )
      );
    } else {
      console.log('[DEBUG RoVer] no embeds on this message');
    }
  }
});

// ---------------- HELPERS ----------------

async function waitForWhoisResponse(channel, targetUserId) {
  console.log(
    `[Monitor] waiting for whois response in #${channel.name} for user ID ${targetUserId}`
  );

  const filter = (m) =>
    m.channel.id === channel.id &&
    m.author.id === BOT_ID &&
    m.embeds &&
    m.embeds.length > 0;

  try {
    const collected = await channel.awaitMessages({
      filter,
      max: 1,
      time: 15000, // 15s timeout
      errors: ['time']
    });

    const reply = collected.first();
    const embed = reply.embeds[0];

    console.log(
      `[Monitor] got whois response in #${channel.name} for user ID ${targetUserId}`
    );

    // Log the whole embed so you can see exactly what RoVer returns
    const plainEmbed = embed.toJSON ? embed.toJSON() : embed;
    console.log('[Monitor] Embed data:', JSON.stringify(plainEmbed, null, 2));

    return plainEmbed;
  } catch (err) {
    console.log(
      `[Monitor] no whois response for user ID ${targetUserId} within 15s`
    );
    console.log('[Monitor] Reason:', err.message || err);
    return null;
  }
}

async function sendToWebhook(payload) {
  try {
    await axios.post(WEBHOOK_URL, payload);
  } catch (err) {
    console.error('[Monitor] Failed to send to webhook:', err.message || err);
  }
}

// ---------------- MAIN LOGIC ----------------

client.on('messageCreate', async (message) => {
  try {
    // only watch specified channels
    if (!MONITOR_CHANNEL_IDS.includes(message.channel.id)) return;
    // ignore bots (RoVer, etc.)
    if (message.author.bot) return;

    const user = message.author;
    const userId = user.id;

    // skip if already processed
    if (checkedUsers.has(userId)) {
      console.log(`[Monitor] skipping ${user.tag}, already checked`);
      return;
    }

    const whoisChannelId = CHANNEL_MAPPING[message.channel.id];
    if (!whoisChannelId) {
      console.log(
        `[Monitor] no whois channel mapped for ${message.channel.id}, skipping`
      );
      return;
    }

    const whoisChannel = await client.channels.fetch(whoisChannelId);
    if (!whoisChannel) {
      console.log(
        `[Monitor] could not fetch whois channel ${whoisChannelId}, skipping`
      );
      return;
    }

    console.log(
      `[Monitor] /whois sent for ${user.tag} (${userId}) in #${whoisChannel.name}`
    );

    // send /whois (adjust format if your server expects something else)
    await whoisChannel.send(`/whois ${userId}`);

    // wait for RoVer reply and log it
    const embedData = await waitForWhoisResponse(whoisChannel, userId);

    if (!embedData) {
      // nothing came back; don't mark as checked so you can try again later
      return;
    }

    // mark as checked ONLY if we got a response
    checkedUsers.add(userId);

    // OPTIONAL: send embed summary to your webhook
    await sendToWebhook({
      content: `Whois data for **${user.tag}** (${userId})`,
      embeds: [embedData]
    });
  } catch (err) {
    console.error('[Monitor] Error in messageCreate handler:', err);
  }
});

// ---------------- LOGIN ----------------

client.login(TOKEN);
