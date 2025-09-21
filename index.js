require('dotenv').config();
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const { Client, GatewayIntentBits } = require('discord.js');
const { Pool } = require('pg');

// =================================================================
// 1. INITIALIZATION & SETUP
// =================================================================

const app = express();
const PORT = process.env.PORT || 10000;

// Setup PostgreSQL database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Required for Render's managed databases
  }
});

// Setup Express web sessions
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
}));

// Setup Discord bot client
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

// The root page, mainly for the keep-alive ping
app.get('/', (req, res) => {
  res.send('CodeBlue Authorization Engine is running.');
});

// The login route: Redirects the user to Discord's authorization screen
app.get('/login', (req, res) => {
  const discordAuthUrl = `https://discord.com/api/oauth2/authorize?client_id=${process.env.CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.BASE_URL + '/callback')}&response_type=code&scope=identify%20guilds.join`;
  res.redirect(discordAuthUrl);
});

// The callback route: Discord redirects the user here after they authorize
app.get('/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.status(400).send('No code provided by Discord.');
  }

  try {
    // Exchange the code for an access token
    const tokenResponse = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
      client_id: process.env.CLIENT_ID,
      client_secret: process.env.CLIENT_SECRET,
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: `${process.env.BASE_URL}/callback`,
    }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const accessToken = tokenResponse.data.access_token;
    const refreshToken = tokenResponse.data.refresh_token;

    // Use the access token to get the user's Discord info
    const userResponse = await axios.get('https://discord.com/api/users/@me', {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });

    const userId = userResponse.data.id;
    const username = userResponse.data.username;

    // Save the user's ID and tokens to the database
    // "ON CONFLICT" updates the tokens if the user already exists, which is good practice
    const query = `
      INSERT INTO users (user_id, username, access_token, refresh_token)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id) DO UPDATE SET
        username = EXCLUDED.username,
        access_token = EXCLUDED.access_token,
        refresh_token = EXCLUDED.refresh_token,
        updated_at = NOW();
    `;
    await pool.query(query, [userId, username, accessToken, refreshToken]);

    // Send a success message to the user's browser
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

client.on('ready', async () => {
  console.log(`[BOT] Logged in as ${client.user.tag}`);
  // Create the database table if it doesn't exist
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      user_id VARCHAR(20) PRIMARY KEY,
      username VARCHAR(32),
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
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

  // Command to generate the authorization link
  if (command === '!!authlink') {
    const authLink = `${process.env.BASE_URL}/login`;
    await message.channel.send({
      content: `**Authorize CodeBlue to Secure Your Membership**\n\nClick the link below to authorize the bot. This will allow us to re-invite you to the server if it is ever recreated.\n\n> ${authLink}`
    });
    console.log(`[BOT] Generated auth link for ${message.author.tag}`);
  }

  // The command to pull members (we will build the logic for this later)
  if (command === '!!members' && args[1] === 'pull') {
    await message.reply('Member pulling logic is not yet implemented.');
  }
});

// =================================================================
// 4. START EVERYTHING
// =================================================================

app.listen(PORT, () => {
  console.log(`[WEB] Web server is listening on port ${PORT}`);
});

client.login(process.env.TOKEN);