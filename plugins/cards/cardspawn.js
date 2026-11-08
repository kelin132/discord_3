import {
  isSpawnEnabled,
  setSpawnEnabled,
  isDiscordSpawnEnabled,
  setDiscordSpawnEnabled,
} from "./db.js";
import { spawnDiscordCardNow } from "../../lib/discordSpawners.mjs";

export default {
  name: "cards",
  aliases: ["cardspawn", "spawncard", "cardauto"],
  description: "Enable or disable automatic card spawning every 12–15 minutes",
  category: "cards",
  usage: ".cards on | .cards off | .cards status",
  isAdmin: true,
  isOwner: true,

  async run({ sock, msg, args, discord }) {
    const discordMessage = discord?.message;
    if (discordMessage?.guild) {
      const channelId = discordMessage.channelId;
      const guildId = discordMessage.guild.id;
      const sub = (args[0] ?? "status").toLowerCase();

      if (sub === "status") {
        const enabled = await isDiscordSpawnEnabled(guildId);
        return discordMessage.reply(
          `🃏 **Automatic Card Spawn**\n\nStatus: ${enabled ? "✅ ON" : "❌ OFF"}\n` +
          "This channel receives a random card every 12–15 minutes.\n\nUse `.cardspawn on` or `.cardspawn off`.",
        );
      }
      if (sub === "on") {
        await setDiscordSpawnEnabled(guildId, channelId, true);
        const spawned = await spawnDiscordCardNow(discordMessage.client, channelId);
        return discordMessage.reply(
          spawned
            ? "✅ Automatic card spawning enabled. A card has spawned in this channel."
            : "✅ Automatic card spawning enabled. The next card will appear automatically.",
        );
      }
      if (sub === "off") {
        await setDiscordSpawnEnabled(guildId, channelId, false);
        return discordMessage.reply("❌ Automatic card spawning disabled in this Discord channel.");
      }
      return discordMessage.reply("❌ Usage: `.cardspawn on`, `.cardspawn off`, or `.cardspawn status`.");
    }

    const chatId = msg.key.remoteJid;

    if (!chatId.endsWith("@g.us")) {
      await sock.sendMessage(chatId, { text: "❌ This command only works in groups." }, { quoted: msg });
      return;
    }

    const sub = (args[0] ?? "status").toLowerCase();

    if (sub === "status") {
      const enabled = await isSpawnEnabled(chatId);
      await sock.sendMessage(chatId, {
        text: `🃏 *Auto Card Spawn*\n\nStatus: ${enabled ? "✅ *ON*" : "❌ *OFF*"}\n\nUse *.cardspawn on* / *.cardspawn off* to change.`,
      }, { quoted: msg });
      return;
    }

    if (sub === "on") {
      await setSpawnEnabled(chatId, true);
      await sock.sendMessage(chatId, {
        text:
`✅ *Auto Card Spawn: ON*

A random card will appear in this group every *12–15 minutes*.
Members can use *.claim <code>* to claim it at the displayed value.`,
      }, { quoted: msg });
      return;
    }

    if (sub === "off") {
      await setSpawnEnabled(chatId, false);
      await sock.sendMessage(chatId, {
        text: "❌ *Auto Card Spawn: OFF*\n\nNo more automatic cards in this group.",
      }, { quoted: msg });
      return;
    }

    await sock.sendMessage(chatId, {
      text: "❌ Usage: *.cardspawn on* | *.cardspawn off* | *.cardspawn status*",
    }, { quoted: msg });
  },
};
