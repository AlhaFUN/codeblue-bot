require('dotenv').config();
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { Pool } = require('pg');

// =================================================================
// 1. INITIALIZATION & SETUP
// =================================================================

const app = express();
const PORT = process.env.PORT || 10000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
}));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// =================================================================
// 2. WEB SERVER LOGIC (THE "ENGINE")
// =================================================================

app.get('/', (req, res) => res.send('CodeBlue Authorization Engine is running.'));

app.get('/login', (req, res) => {
  const discordAuthUrl = `https://discord.com/api/oauth2/authorize?client_id=${process.env.CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.BASE_URL + '/callback')}&response_type=code&scope=identify%20guilds.join`;
  res.redirect(discordAuthUrl);
});

app.get('/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('No code provided by Discord.');

  try {
    const tokenResponse = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
      client_id: process.env.CLIENT_ID,
      client_secret: process.env.CLIENT_SECRET,
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: `${process.env.BASE_URL}/callback`,
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    const { access_token, refresh_token } = tokenResponse.data;

    const userResponse = await axios.get('https://discord.com/api/users/@me', {
      headers: { 'Authorization': `Bearer ${access_token}` },
    });

    const { id: userId, username } = userResponse.data;

    const query = `
      INSERT INTO users (user_id, username, access_token, refresh_token)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id) DO UPDATE SET
        username = EXCLUDED.username,
        access_token = EXCLUDED.access_token,
        refresh_token = EXCLUDED.refresh_token,
        updated_at = NOW();
    `;
    await pool.query(query, [userId, username, access_token, refresh_token]);

    res.send(`<h1>Success!</h1><p>Thank you, ${username}. Your account is now secured with CodeBlue. You can close this tab.</p>`);
    console.log(`[AUTH] Successfully authorized and saved tokens for ${username} (${userId})`);
  } catch (error) {
    console.error('Error during OAuth2 callback:', error.response ? error.response.data : error.message);
    res.status(500).send('An error occurred while authenticating with Discord.');
  }
});

// =================================================================
// 3. DISCORD BOT LOGIC (THE "INTERFACE")
// =================================================================

async function handleMemberPull(message, args) {
  const targetGuildId = args[2];
  if (!targetGuildId) {
    return message.reply('❌ Please provide the ID of the server to pull members into. Usage: `!!members pull <server_ID>`');
  }

  const initialEmbed = new EmbedBuilder()
    .setColor('#5865F2')
    .setTitle('CodeBlue Member Pull - Initializing... 🏃‍♂️')
    .setDescription('The process is starting. Please wait...')
    .addFields(
      { name: 'Status', value: '`▶️` **Fetching User Tokens:** `[Pending]`\n`⏸️` **Pulling Members:** `[Pending]`\n`⏸️` **Finalizing Report:** `[Pending]`' },
      { name: 'Progress', value: '`0 / ???`', inline: true },
      { name: 'Elapsed Time', value: '`0s`', inline: true }
    )
    .setTimestamp();

  const statusMessage = await message.channel.send({ embeds: [initialEmbed] });
  const startTime = Date.now();

  try {
    const { rows: users } = await pool.query('SELECT user_id, access_token FROM users');
    const totalUsers = users.length;

    let embed = EmbedBuilder.from(statusMessage.embeds[0])
        .setTitle('CodeBlue Member Pull - In Progress... 🏃‍♂️')
        .setFields(
            { name: 'Status', value: `\`✅\` **Fetching User Tokens:** \`[Done - Found ${totalUsers} users]\`\n\`▶️\` **Pulling Members:** \`[In Progress]\`\n\`⏸️\` **Finalizing Report:** \`[Pending]\`` },
            { name: 'Progress', value: `\`0 / ${totalUsers}\``, inline: true },
            { name: 'Elapsed Time', value: '`~0s`', inline: true }
        );
    await statusMessage.edit({ embeds: [embed] });

    let successCount = 0;
    let failCount = 0;
    let lastUpdateTime = Date.now();

    for (let i = 0; i < users.length; i++) {
      const user = users[i];
      try {
        await axios.put(`https://discord.com/api/v10/guilds/${targetGuildId}/members/${user.user_id}`,
          { access_token: user.access_token },
          { headers: { 'Authorization': `Bot ${process.env.TOKEN}`, 'Content-Type': 'application/json' } }
        );
        successCount++;
      } catch (error) {
        failCount++;
      }

      const now = Date.now();
      if (now - lastUpdateTime > 5000 || (i + 1) % 25 === 0 || i === users.length - 1) {
        const elapsedTime = Math.round((now - startTime) / 1000);
        embed.setFields(
            { name: 'Status', value: `\`✅\` **Fetching User Tokens:** \`[Done - Found ${totalUsers} users]\`\n\`▶️\` **Pulling Members:** \`[In Progress]\`\n\`⏸️\` **Finalizing Report:** \`[Pending]\`` },
            { name: 'Progress', value: `\`${i + 1} / ${totalUsers}\``, inline: true },
            { name: 'Elapsed Time', value: `\`${elapsedTime}s\``, inline: true },
            { name: 'Success / Fail', value: `\`${successCount} / ${failCount}\``, inline: true }
        );
        await statusMessage.edit({ embeds: [embed] });
        lastUpdateTime = now;
      }
    }

    const finalElapsedTime = Math.round((Date.now() - startTime) / 1000);
    const finalEmbed = new EmbedBuilder()
      .setColor('#4CAF50')
      .setTitle('CodeBlue Member Pull - Complete! ✅')
      .setDescription('The member recovery process has finished.')
      .addFields(
        { name: 'Status', value: '`✅` **Fetching User Tokens:** `[Done]`\n`✅` **Pulling Members:** `[Done]`\n`✅` **Finalizing Report:** `[Done]`' },
        { name: 'Successfully Added', value: `\`${successCount} members\``, inline: true },
        { name: 'Failed to Add', value: `\`${failCount} members\``, inline: true },
        { name: 'Total Time Taken', value: `\`${finalElapsedTime}s\``, inline: true }
      )
      .setTimestamp();
    await statusMessage.edit({ embeds: [finalEmbed] });
  } catch (error) {
    console.error('CRITICAL ERROR during member pull:', error);
    const errorEmbed = new EmbedBuilder()
      .setColor('#F44336')
      .setTitle('CodeBlue Member Pull - CRITICAL FAILURE ❌')
      .setDescription('An unexpected error occurred during the process. Please check the logs.');
    await statusMessage.edit({ embeds: [errorEmbed] });
  }
}

client.on('ready', async () => {
  console.log(`[BOT] Logged in as ${client.user.tag}`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      user_id VARCHAR(20) PRIMARY KEY, username VARCHAR(32),
      access_token TEXT NOT NULL, refresh_token TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('[DB] "users" table is ready.');
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.content.startsWith('!!') || !message.member.permissions.has('Administrator')) {
    return;
  }
  const args = message.content.trim().split(/\s+/);
  const command = args[0].toLowerCase();

  if (command === '!!authlink') {
    const authLink = `${process.env.BASE_URL}/login`;
    await message.channel.send({
      content: `**Authorize CodeBlue to Secure Your Membership**\n\nClick the link below to authorize the bot. This will allow us to re-invite you to the server if it is ever recreated.\n\n> ${authLink}`
    });
    console.log(`[BOT] Generated auth link for ${message.author.tag}`);
  }

  if (command === '!!members' && args[1] === 'pull') {
    // Call our new function
    await handleMemberPull(message, args);
  }
});

// =================================================================
// 4. START EVERYTHING
// =================================================================

app.listen(PORT, () => {
  console.log(`[WEB] Web server is listening on port ${PORT}`);
});

client.login(process.env.TOKEN);