const { Client } = require('discord.js-selfbot-v13');
const axios = require('axios');
const { Builder, By } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');

// Use environment variable for token (more secure)
const TOKEN = process.env.DISCORD_TOKEN || 'ODAzMzc0MDgyODE2MzQ0MDk0.G8QsjH.U965vGebzKvH7hILJPeShMFV24ku2Qgr9gtvxU';
const MONITOR_CHANNEL_ID = '430203025659789343';
const WHOIS_CHANNEL_ID = '1393342132583927821';
const WEBHOOK_URL = 'https://discord.com/api/webhooks/1403167152751513642/Hm5U3_t_D8VYMN9Q3qUXnhzKGSeM2F-f3CyKVdedbH_k9BDPHYPGAsewO24FXepjIUzm';
const BOT_ID = '298796807323123712';
const ALLOWED_ROLES = [
  "Verified", "Nitro Booster", "200k Members", "Game Night", "Weeb",
  "Art Talk", "Music", "Pets", "Rolimon's News Pings", "Content Pings",
  "Roblox News Pings", "Trading News Pings", "Limited Pings", "UGC Limited Pings",
  "-Free UGC Limited Pings", "Free UGC Limited Game Pings", "Upcoming UGC Limiteds Ping",
  "Free UGC Event Pings", "Poll Pings", "Value Change Pings", "Projection Pings"
];

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

let driver;
async function initializeWebDriver() {
  try {
    const options = new chrome.Options();
    options.addArguments('--headless', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-web-security', '--disable-features=VizDisplayCompositor');
    driver = await new Builder().forBrowser('chrome').setChromeOptions(options).build();
    console.log('WebDriver initialized successfully');
  } catch (error) {
    console.error('Error initializing WebDriver:', error.message);
  }
}

async function scrapeRolimons(robloxUserId) {
  if (!driver) {
    console.error('WebDriver not initialized');
    return { value: 0, tradeAds: 0, avatarUrl: '', rolimonsUrl: `https://www.rolimons.com/player/${robloxUserId}` };
  }

  const url = `https://www.rolimons.com/player/${robloxUserId}`;
  try {
    await driver.get(url);
    await driver.sleep(3000);

    let value = 0, tradeAds = 0, avatarUrl = '';
    try {
      const valueElem = await driver.findElement(By.id('player_value'));
      value = parseInt((await valueElem.getText()).replace(/,/g, '')) || 0;
    } catch {}
    try {
      const tradeAdsElem = await driver.findElement(By.css('span.card-title.mb-1.text-light.stat-data.text-nowrap'));
      tradeAds = parseInt((await tradeAdsElem.getText()).replace(/,/g, '')) || 0;
    } catch {}
    try {
      const avatarElem = await driver.findElement(By.css('img.mx-auto.d-block.w-100.h-100'));
      avatarUrl = await avatarElem.getAttribute('src');
    } catch {}
    return { value, tradeAds, avatarUrl, rolimonsUrl: url };
  } catch (error) {
    console.error('Error scraping Rolimons:', error.message);
    return { value: 0, tradeAds: 0, avatarUrl: '', rolimonsUrl: url };
  }
}

const client = new Client({ checkUpdate: false });

let processedUsers = new Set();
let pendingRoblox = new Map();

client.on('ready', async () => {
  console.log(`[Monitor] Logged in as ${client.user.tag}`);
  await fetchBlockedUsers();
  await initializeWebDriver();
});

client.on('messageCreate', async (message) => {
  if (blockedUsers.has(message.author.id)) return;
  if (message.channel.id !== MONITOR_CHANNEL_ID) return;
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

  // Store the message info keyed by Discord ID (for now)
  pendingRoblox.set(message.author.id, {
    discordId: message.author.id,
    discordTag: message.author.tag,
    content: message.content,
    timestamp: message.createdTimestamp
  });
  const whoisChannel = await client.channels.fetch(WHOIS_CHANNEL_ID);
  if (!whoisChannel) return;
  await whoisChannel.sendSlash(BOT_ID, 'whois discord', message.author.id);
  console.log(`[Monitor] Sent /whois discord for ${message.author.tag} (${message.author.id})`);
});

// Listen for bot responses globally
client.on('messageCreate', async (message) => {
  if (
    message.author.id === BOT_ID &&
    message.channel.id === WHOIS_CHANNEL_ID &&
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
    // We'll need to scrape Rolimons to get the Discord ID, so we check all pending
    for (const [discordId, msg] of pendingRoblox.entries()) {
      if (processedUsers.has(discordId)) continue;
      // Scrape Rolimons and check value
      const { value, tradeAds, avatarUrl, rolimonsUrl } = await scrapeRolimons(robloxUserId);
      console.log(`[Monitor] Scraped value: ${value}, tradeAds: ${tradeAds}`);
      if (value >= 50000) {
        try {
          await axios.post(WEBHOOK_URL, {
            content: '@everyone',
            embeds: [
              {
                title: 'User Message',
                description: `**Message:** ${msg.content}\n**Discord:** ${msg.discordTag}`,
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
          pendingRoblox.delete(discordId);
          console.log('[Monitor] Sent to webhook!');
          break; // Only process the first match
        } catch (error) {
          console.error('Error sending webhook:', error.message);
        }
      } else {
        console.log('[Monitor] User did not meet value requirement.');
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

process.on('SIGINT', async () => {
  console.log('Shutting down...');
  if (driver) {
    await driver.quit();
  }
  process.exit(0);
});

// Start the bot
client.login(TOKEN).catch(error => {
  console.error('Failed to login:', error);
  process.exit(1);
});