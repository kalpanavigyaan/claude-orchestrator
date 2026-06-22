import 'dotenv/config';
import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { Telegraf } from 'telegraf';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir  = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dir, '..', 'public');

const BOT_TOKEN    = process.env.BOT_TOKEN;
const MINI_APP_URL = process.env.MINI_APP_URL;  // ngrok HTTPS URL
const FLEET_URL    = process.env.FLEET_URL || 'http://localhost:4318';
const PORT         = Number(process.env.PORT) || 3001;

if (!BOT_TOKEN)    throw new Error('BOT_TOKEN is required — copy .env.example to .env');
if (!MINI_APP_URL) throw new Error('MINI_APP_URL is required — run ngrok http 3001 and set the HTTPS URL');

// ── Express: static + fleet proxy ────────────────────────────────────────────

const app = express();

// Serve the mini app HTML/JS/CSS
app.use(express.static(PUBLIC));

// Proxy /api/* → fleet console
app.use('/api', createProxyMiddleware({
  target: FLEET_URL,
  changeOrigin: true,
  on: {
    error: (err, _req, res) => {
      console.error('[proxy]', err.message);
      res.status(502).json({ error: 'Fleet console unreachable', detail: err.message });
    },
  },
}));

app.listen(PORT, () => {
  console.log(`\n┌─ Telegram Fleet App ────────────────────────────┐`);
  console.log(`│  Mini app server : http://localhost:${PORT}          │`);
  console.log(`│  Fleet console   : ${FLEET_URL.padEnd(28)} │`);
  console.log(`│  ngrok URL       : ${MINI_APP_URL.slice(0, 28).padEnd(28)} │`);
  console.log(`└─────────────────────────────────────────────────┘\n`);
});

// ── Telegraf bot ──────────────────────────────────────────────────────────────

const bot = new Telegraf(BOT_TOKEN);

bot.command('start', ctx => {
  ctx.reply(
    `👋 Hello ${ctx.from.first_name}!\n\nI'm your Fleet Console gateway. Use /fleet to open the mini app and send instructions to Claude sessions running on your machine.`,
  );
});

bot.command('fleet', ctx => {
  ctx.reply('Open Fleet Console:', {
    reply_markup: {
      inline_keyboard: [[{
        text: '🤖 Open Fleet Console',
        web_app: { url: MINI_APP_URL },
      }]],
    },
  });
});

// Receive data sent back from the mini app via Telegram.WebApp.sendData()
bot.on('message', ctx => {
  const data = ctx.message?.web_app_data?.data;
  if (!data) return;
  try {
    const { label, text } = JSON.parse(data);
    ctx.reply(`✅ Sent to *${label}*:\n\`${text}\``, { parse_mode: 'Markdown' });
  } catch {
    ctx.reply(`✅ Message sent to Fleet Console.`);
  }
});

bot.launch();
console.log('Bot polling started — send /fleet in Telegram to open the mini app\n');

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
