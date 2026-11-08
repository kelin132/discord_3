import { getUser, requireRegistration } from "./database.js";
import { formatAccountBalance } from "./balanceFormat.js";
import { bankLimitForUser, formatRyu } from "./currency.js";

export default {
  name: "balance",
  description: "Check your wallet and bank balance",
  category: "economy",
  usage: ".balance",
  aliases: ["bal", "money", "wallet"],
  cooldown: 6,

  async run({ sock, msg, sender, discord }) {
    if (!await requireRegistration(sock, msg, sender)) return;

    const user = await getUser(sender);
    const jid  = msg.key.remoteJid;
    const text = formatAccountBalance({
      wallet: user.money,
      bank: user.bank,
      crystals: user.genesisCrystals,
      bankLimit: bankLimitForUser(user),
      footerLines: ["Buy higher bank limits in .shop banking."],
    });

    if (discord?.message) {
      const displayName = discord.message.member?.displayName
        || discord.message.author?.globalName
        || discord.message.author?.username
        || "Your";
      return sock.sendMessage(jid, {
        discordEmbed: {
          title: `${displayName}'s Balance 🌸`,
          description: "Here are your current funds:",
          color: "#6875F5",
          fields: [
            {
              name: "🪙 Wallet",
               value: formatRyu(user.money),
              inline: false,
            },
            {
              name: "🏦 Bank",
               value: `${formatRyu(user.bank)} / ${formatRyu(bankLimitForUser(user))}`,
              inline: false,
            },
          ],
        },
        mentions: [sender],
      }, { quoted: msg });
    }

    await sock.sendMessage(jid, { text, mentions: [sender] }, { quoted: msg });
  },
};
