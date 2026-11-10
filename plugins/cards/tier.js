import { findOrCreateUser } from "./db.js";

const TIER_MAP = {
  Common: "1", Uncommon: "2", Rare: "3",
  Epic: "4", Legendary: "5", Mythical: "6", Mythic: "6", Secret: "S",
  C: "C", R: "R", SR: "SR", SSR: "SSR", UR: "UR", X: "X",
};
const VALID_TIERS = ["1", "2", "3", "4", "5", "6", "S", "C", "R", "SR", "SSR", "UR", "X"];
const TIER_CODES_BY_NAME = Object.fromEntries(
  Object.entries(TIER_MAP).map(([name, code]) => [name.toLowerCase(), code]),
);

export default {
  name: "tier",
  aliases: ["mytiers"],
  category: "cards",
  description: "View your cards grouped by tier",
   usage: ".tier [1-6 or S]",

  async run({ sock, msg, args, sender }) {
    const jid   = msg.key.remoteJid;
    const reply = (text) => sock.sendMessage(jid, { text }, { quoted: msg });

    try {
      const user = await findOrCreateUser(sender);

      if (!Array.isArray(user.cards) || user.cards.length === 0) {
        return reply("❌ You don't have any cards.");
      }

      const filterInput = String(args[0] || "").trim();
      const filterTier = filterInput
        ? (TIER_CODES_BY_NAME[filterInput.toLowerCase()] || filterInput.toUpperCase())
        : null;

      if (filterTier && !VALID_TIERS.includes(filterTier)) {
        return reply("❌ Invalid tier. Use 1–6, S, C, R, SR, SSR, UR, or X.");
      }

      const ReadMore = "\u200e".repeat(4000);

      let text =
`🃏 *Tier Filtered Collection*

${ReadMore}
📦 Total Cards: ${user.cards.length}
`;

      const filtered = filterTier
        ? user.cards.filter(c => (TIER_MAP[c.tier] || "?") === filterTier)
        : user.cards;

      if (filterTier && filtered.length === 0) {
        return reply(`❌ No cards found in tier ${filterTier}`);
      }

      if (filterTier) {
        text += `\n🎯 *Tier ${filterTier} Cards:*\n\n`;
        filtered.forEach((card, i) => { text += `${i + 1}. 🃏 ${card.name}\n`; });
      } else {
        const grouped = Object.fromEntries(VALID_TIERS.map((tier) => [tier, []]));
        for (const card of filtered) {
          const t = card.tierNum || TIER_MAP[card.tier] || "?";
          if (grouped[t]) grouped[t].push(card.name);
        }

        text += "\n📊 *Grouped by Tier*\n";
        for (const tier of VALID_TIERS) {
          const list = grouped[tier];
          text += `\n🏷️ *Tier ${tier}*\n`;
          if (list.length === 0) {
            text += "- None\n";
          } else {
            list.forEach((name, i) => { text += `*${i + 1}. ${name}*\n`; });
          }
        }
      }

      return await sock.sendMessage(jid, { text, mentions: [sender] }, { quoted: msg });

    } catch (err) {
      console.error("TIER ERROR:", err);
      return reply("❌ Failed to load tier list.");
    }
  },
};
