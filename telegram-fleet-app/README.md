# Telegram Fleet App

A Telegram Mini App that lets you send instructions to Claude sessions in the
[Fleet Console](../fleet-console/) directly from the Telegram app on your phone.

## How it works

```
Telegram (phone)  →  Mini App  →  Bot Server  →  Fleet Console API
                  (ngrok HTTPS)  (localhost:3001)  (localhost:4318)
```

1. You type `/fleet` in Telegram.
2. The bot replies with a button that opens a web page inside Telegram.
3. The page lists your active Claude sessions; you pick one, type a message, and tap **Send**.
4. The message is routed through the bot server (which proxies to your local fleet console) and delivered to the Claude session.
5. The bot confirms the send with a reply.

## Setup

### 1. Create a Telegram Bot

1. Open Telegram and message **@BotFather**.
2. Send `/newbot`, follow the prompts, copy the **BOT_TOKEN**.

### 2. Configure

```powershell
Copy-Item .env.example .env
# Edit .env and set BOT_TOKEN
```

### 3. Install dependencies

```powershell
npm install
```

### 4. Start ngrok

Telegram requires HTTPS for Mini Apps. Use [ngrok](https://ngrok.com) to expose
the local server:

```powershell
ngrok http 3001
```

Copy the `https://xxx.ngrok-free.app` URL into `.env` as `MINI_APP_URL`.
You need to update this every time you restart ngrok (unless you have a static domain).

### 5. Start everything

Terminal 1 — Fleet Console:
```powershell
.\scripts\start-fleet-console.ps1
```

Terminal 2 — Telegram bot server:
```powershell
cd telegram-fleet-app
.\scripts\start.ps1
```

### 6. Open in Telegram

Send `/fleet` to your bot. Tap **Open Fleet Console** to launch the mini app.

## File structure

```
telegram-fleet-app/
  src/
    bot.mjs          Express server + Telegraf bot
  public/
    index.html       Mini App UI (vanilla JS, dark theme)
  scripts/
    start.ps1        Start script with checklist
  .env.example       Environment variable template
```

## Environment variables

| Variable | Description |
|----------|-------------|
| `BOT_TOKEN` | From @BotFather |
| `MINI_APP_URL` | ngrok HTTPS URL pointing at port 3001 |
| `FLEET_URL` | Fleet console API (default: `http://localhost:4318`) |
| `PORT` | Bot server port (default: `3001`) |
