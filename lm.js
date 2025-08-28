const { Client } = require('discord.js-selfbot-v13');
const axios = require('axios');
const { Builder, By } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');

// Use environment variable for token (more secure)
const TOKEN = process.env.DISCORD_TOKEN
const MONITOR_CHANNEL_IDS = ['430203025659789343', '442709792839172099', '442709710408515605'];

// Map monitor channels to their corresponding whois channels
const CHANNEL_MAPPING = {
  '430203025659789343': '1393342132583927821', // lounge
  '442709792839172099': '1403939114683863180', // trade lounge
  '442709710408515605': '1403939122904825856'  // trade ads
};

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
    console.log('🔧 Initializing Selenium WebDriver...');
    const options = new chrome.Options();
    
    // Cloud-optimized Chrome options
    options.addArguments(
        '--headless',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
        '--disable-extensions',
        '--disable-plugins',
        '--memory-pressure-off',
        '--max_old_space_size=4096'
    );
    
    // Set Chrome binary path for cloud environments
    if (process.env.NODE_ENV === 'production') {
        options.setChromeBinaryPath('/usr/bin/chromium');
    }
    
    driver = await new Builder()
        .forBrowser('chrome')
        .setChromeOptions(options)
        .build();
        
    console.log('✅ Selenium WebDriver initialized successfully');
  } catch (error) {
    console.error('❌ WebDriver initialization error:', error.message);
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
let webhookSent = new Set(); // Track which users we've already sent webhooks for

client.on('ready', async () => {
  console.log(`[Monitor] Logged in as ${client.user.tag}`);
  await fetchBlockedUsers();
  await initializeWebDriver();
  console.log(`[Monitor] Bot ready and monitoring ${MONITOR_CHANNEL_IDS.length} channels!`);
  console.log(`[Monitor] Channels: ${MONITOR_CHANNEL_IDS.join(', ')}`);
  console.log(`[Monitor] Channel mapping:`, CHANNEL_MAPPING);
});

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
  const userRoleNames = member.roles.cache.filter(r => r.name !== '@everyone').map(r => r.name);
  const onlyAllowedRoles = userRoleNames.length > 0 && userRoleNames.every(roleName => ALLOWED_ROLES.includes(roleName));
  if (!onlyAllowedRoles) return;

  // Get the corresponding whois channel for this monitor channel
  const whoisChannelId = CHANNEL_MAPPING[message.channel.id];
  if (!whoisChannelId) {
    console.log(`[Monitor] No whois channel mapping found for ${message.channel.id}`);
    return;
  }

  // Store the message info keyed by Discord ID (for now)
  pendingRoblox.set(message.author.id, {
    discordId: message.author.id,
    discordTag: message.author.tag,
    content: message.content,
    timestamp: message.createdTimestamp,
    channelId: message.channel.id,
    channelName: message.channel.name,
    whoisChannelId: whoisChannelId
  });
  
  const whoisChannel = await client.channels.fetch(whoisChannelId);
  if (!whoisChannel) return;
  await whoisChannel.sendSlash(BOT_ID, 'whois discord', message.author.id);
  console.log(`[Monitor] Sent /whois discord for ${message.author.tag} (${message.author.id}) in #${message.channel.name} -> whois channel ${whoisChannelId}`);
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
    // We'll need to scrape Rolimons to get the Discord ID, so we check all pending
    for (const [discordId, msg] of pendingRoblox.entries()) {
      if (processedUsers.has(discordId)) continue;
      
      // Scrape Rolimons and check value
      const { value, tradeAds, avatarUrl, rolimonsUrl } = await scrapeRolimons(robloxUserId);
      console.log(`[Monitor] Scraped value: ${value}, tradeAds: ${tradeAds}`);
      
      if (value >= 50000) {
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
                description: `**Message:** ${msg.content}\n**Discord:** ${msg.discordTag}\n**Channel:** #${msg.channelName}`,
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
          
          // Mark this user as processed and webhook sent
          processedUsers.add(discordId);
          webhookSent.add(discordId);
          pendingRoblox.delete(discordId);
          console.log(`[Monitor] Sent webhook for ${msg.discordTag} with value ${value} from #${msg.channelName}!`);
          break; // Only process the first match
        } catch (error) {
          console.error('Error sending webhook:', error.message);
          // Don't mark as processed if webhook failed
        }
      } else {
        console.log(`[Monitor] User did not meet value requirement (${value} < 50000).`);
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
