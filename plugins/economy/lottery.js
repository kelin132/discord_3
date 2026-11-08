/**
 * .lottery       — buy one lottery ticket ($500; one ticket per player)
 * .lottery draw — owner-only: draw the winning tickets
 */
import { getUser, requireRegistration, addHistory } from "./database.js";
import { getDb } from "../../lib/mongo.mjs";
import { getLotteryRound, findAccountLotteryTicket, purchaseLotteryTicket } from "../../lib/lotteryEntry.mjs";
import { getLotteryAnnouncementChannel } from "../../lib/lotterySettings.mjs";
import {
  drawLottery,
  getDiscordParticipantId,
  REQUIRED_LOTTERY_ENTRIES,
  queueLotteryAnnouncement,
} from "../../lib/lotteryDraw.mjs";
import { getEconomyPreviewConfig } from "../../lib/economyPreview.mjs";

const TICKET_PRICE  = 15_000;
const MAX_TICKETS   = 1;
const MIN_JACKPOT   = 10_000_000;
const MAX_JACKPOT   = 50_000_000;

function randomBaseJackpot() {
  return Math.floor(Math.random() * (MAX_JACKPOT - MIN_JACKPOT + 1)) + MIN_JACKPOT;
}

async function getLottery() {
  return getLotteryRound(getDb(), randomBaseJackpot());
}

export default {
  name: "lottery",
  aliases: ["lotto"],
  category: "economy",
  cooldown: 6,
  description: "Buy one lottery ticket or draw the jackpot",
  usage: ".lottery  |  .lottery draw",
  discordColor: "#F1C40F",
  discordTitle: "🎰 Lottery",

  async run({ sock, msg, sender, rawSender, args, isOwner, staffLevel, discord }) {
    if (!await requireRegistration(sock, msg, sender)) return;

    const jid  = msg.key.remoteJid;
    const reply = (text) => sock.sendMessage(jid, { text }, { quoted: msg });
    const sub = (args[0] || "ticket").toLowerCase();

    if (sub === "ticket") {
      if (args.length > 0) {
        return reply("❌ Use `.lottery` to buy your one ticket. `.lottery draw` is owner-only.");
      }
      const count = 1;

      let lot     = await getLottery();
      const discordId = getDiscordParticipantId(discord, rawSender);
      const myEntry = await findAccountLotteryTicket(getDb(), lot.tickets, sender, discordId);
      const myCount = myEntry?.count ?? 0;

      if (myCount >= MAX_TICKETS) {
        if (discord?.message) {
          return sock.sendMessage(jid, {
            discordEmbed: {
              title: "🎰 Global Lottery",
              description: "You have already entered the global lottery.",
              color: "#F1C40F",
              fields: [
                { name: "🎟️ Entry", value: "Already entered", inline: true },
                { name: "🎫 Tickets", value: String(myCount), inline: true },
              ],
              footer: { text: "Use .lotterylist to see the draw." },
            },
            mentions: [sender],
          }, { quoted: msg });
        }

        return reply(
`╭━━━〔 🔒 𝑴𝑨𝑿 𝑻𝑰𝑪𝑲𝑬𝑻𝑺 〕━━━╮
┃ ✦ You already hold the maximum tickets!
┃
┃ 🎟️ Your Ticket › already purchased
┃
╰━━━━━━━━━━━━━━━━━━━━━━╯`
        );
      }

      const canBuy = Math.min(count, MAX_TICKETS - myCount);
      const cost   = canBuy * TICKET_PRICE;
      const user   = await getUser(sender);

      if (user.money < cost) {
        return reply(
`╭━━━〔 💸 𝑰𝑵𝑺𝑼𝑭𝑭𝑰𝑪𝑰𝑬𝑵𝑻 𝑭𝑼𝑵𝑫𝑺 〕━━━╮
┃ ✦ Not enough cash for tickets!
┃
┃ 🏷️  Cost    › $${cost.toLocaleString()}
┃ 👛 Wallet  › $${user.money.toLocaleString()}
┣━━━━━━━━━━━━━━━━━━━━
┃ 💡 Earn more via .work .daily .crime
╰━━━━━━━━━━━━━━━━━━━━╯`
        );
      }

      const purchase = await purchaseLotteryTicket({
        db: getDb(), lot, sender, discordId, price: cost,
        name: discord?.message?.member?.displayName
          || discord?.message?.author?.globalName
          || discord?.message?.author?.username || user.name,
        groupId: !discord?.message ? jid : null,
      });
      if (!purchase.ok) {
        return reply(purchase.reason === "duplicate"
          ? "⚠️ You have already entered the global lottery on WhatsApp or Discord."
          : purchase.reason === "funds" ? "❌ Not enough cash for a ticket."
            : "⏳ The lottery is drawing now. Please try again in a moment.");
      }
      await addHistory(purchase.accountId, "lottery", -cost, "Bought one lottery ticket").catch(error => {
        console.error("[lottery] Could not record purchase history:", error.message);
      });
      lot = await getLottery();

      await reply(`You have bought a ticket for $${cost.toLocaleString()}, Goodluck!\n${getEconomyPreviewConfig("lottery")?.url ?? ""}`);

      if (lot.totalTickets >= REQUIRED_LOTTERY_ENTRIES) {
        const guildId = discord?.message?.guildId || msg.guildId || null;
        const configuredChannel = guildId
          ? await getLotteryAnnouncementChannel(guildId)
          : null;
        const result = await drawLottery({
          db: getDb(),
          minimumEntries: REQUIRED_LOTTERY_ENTRIES,
          guildId,
          announcementChannelId: configuredChannel,
          discord,
        });
        if (result.ok) {
          await sock.sendMessage(jid, result.message);
          if (configuredChannel && String(configuredChannel) !== String(jid)) {
            await sock.sendMessage(configuredChannel, result.message).catch((error) => {
              console.error("[lottery] Failed to post configured announcement:", error.message);
            });
          }
          await queueLotteryAnnouncement({ db: getDb(), result, sourcePlatform: discord?.message ? "discord" : "whatsapp", whatsappGroupId: String(jid).endsWith("@g.us") ? jid : null });
        }
      }
      return;
    }

    // ── DRAW (owner only) ──────────────────────────────────────────────────────
    if (sub === "draw") {
      if (!isOwner && (staffLevel || 0) < 2) return reply(
`╭━━━〔 🔒 𝑨𝑪𝑪𝑬𝑺𝑺 𝑫𝑬𝑵𝑰𝑬𝑫 〕━━━╮
┃ ✦ Insufficient permissions!
┃
┃ 🎰 Drawing requires:
┃    › Owner  OR  Staff Level 2+
╰━━━━━━━━━━━━━━━━━━━━╯`
      );

      const guildId = discord?.message?.guildId || msg.guildId || null;
      const announcementChannelId = guildId
        ? await getLotteryAnnouncementChannel(guildId)
        : null;
      const result = await drawLottery({
        db: getDb(),
        minimumEntries: REQUIRED_LOTTERY_ENTRIES,
        guildId,
        announcementChannelId,
        discord,
      });
      if (!result.ok) {
        return reply(result.reason === "empty"
          ? "❌ No tickets have been bought yet."
          : "❌ The lottery could not be drawn.");
      }
      await sock.sendMessage(jid, result.message, { quoted: msg });
      if (announcementChannelId && String(announcementChannelId) !== String(jid)) {
        await sock.sendMessage(announcementChannelId, result.message).catch((error) => {
          console.error("[lottery] Failed to post configured announcement:", error.message);
        });
      }
      await queueLotteryAnnouncement({ db: getDb(), result, sourcePlatform: discord?.message ? "discord" : "whatsapp", whatsappGroupId: String(jid).endsWith("@g.us") ? jid : null });
      return;
    }

    return reply(
`╭━━━〔 ℹ️ 𝑼𝑺𝑨𝑮𝑬 〕━━━╮
┃ .lottery       — buy one ticket
┃ .lottery draw — draw winners (owner)
┃ .lotterylist   — see all players
╰━━━━━━━━━━━━━━━━━━━━╯`
    );
  },
};
