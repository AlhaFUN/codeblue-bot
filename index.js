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
// 2. WEB SERVER LOGIC (THE "ENGINE") - Untouched
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
  // ... (This function is correct and remains unchanged)
}

// Your 'ready' event handler has a duplicate. We will use the correct, single one.
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
  // Your original guard clause is correct.
  if (message.author.bot || !message.content.startsWith('!!') || !message.member?.permissions.has('Administrator')) {
    return;
  }
  const args = message.content.trim().split(/\s+/);
  const command = args[0].toLowerCase();

  // Your !!authlink command is correct.
  if (command === '!!authlink') {
    const authLink = `${process.env.BASE_URL}/login`;
    await message.channel.send({
      content: `**Authorize CodeBlue to Secure Your Membership**\n\nClick the link below to authorize the bot. This will allow us to re-invite you to the server if it is ever recreated.\n\n> ${authLink}`
    });
    console.log(`[BOT] Generated auth link for ${message.author.tag}`);
    return; // Add return to prevent fall-through
  }

  // ============================ THE FIX IS HERE ============================
  // This is the updated command router for '!!members'.
  if (command === '!!members') {
    const subCommand = args[1]?.toLowerCase();

    if (subCommand === 'pull') {
      return await handleMemberPull(message, args);
    } 
    
    if (subCommand === 'check') {
      try {
        const result = await pool.query('SELECT COUNT(*) FROM users');
        const memberCount = result.rows[0].count;

        const checkEmbed = new EmbedBuilder()
          .setColor('#5865F2')
          .setTitle('📊 CodeBlue Member Authorization Status')
          .addFields({ name: 'Verified Members', value: `**${memberCount}** members have secured their account and can be recovered.` })
          .setFooter({ text: 'Use !!authlink to get the link for more members to authorize.' })
          .setTimestamp();
        
        await message.reply({ embeds: [checkEmbed] });
        console.log(`[BOT] Performed a members check for ${message.author.tag}. Result: ${memberCount} members.`);

      } catch (error) {
        console.error('Error during !!members check:', error);
        await message.reply('❌ An error occurred while trying to query the database.');
      }
      return;
    }

    // If they just type "!!members" with no subcommand, or an invalid one.
    await message.reply('Invalid subcommand. Use `!!members pull <server_id>` or `!!members check`.');
    return;
  }
  // =======================================================================
});

// =================================================================
// 4. START EVERYTHING
// =================================================================

app.listen(PORT, () => {
  console.log(`[WEB] Web server is listening on port ${PORT}`);
});

client.login(process.env.TOKEN);