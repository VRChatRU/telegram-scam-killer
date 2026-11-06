# telegram-scam-killer

Telegram bot that checks group messages for scams, shares moderation alerts across admins, and syncs Delation bans.

1. Copy `example.env` to `.env` and set `BOT_TOKEN`, `ADMIN_IDS`, `OPENROUTER_KEY`, and `UPTIME_KUMA_URL`. Every listed admin must open the same bot and send `/start`.
2. Enable **Bot-to-Bot Communication Mode** and disable **Group Privacy** in [@BotFather](https://t.me/BotFather). Re-add the bot if you changed Group Privacy. Make it a group admin with permission to delete messages and ban users. Use a supergroup for kick mode.
3. Run one instance with `bun run start` on [Bun 1.4.4 or newer](https://bun.sh/).
