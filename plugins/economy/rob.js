import { getUser, saveUser, requireRegistration, isRegistered, addHistory, jailUser } from "./database.js";
import { hasActiveGun } from "../../lib/economySecurity.mjs";
import { compactMoney } from "../../lib/compactMoney.mjs";

function fmt(n) {
  return compactMoney(n);
}

function robReply({ sock, jid, msg, discord, text, title, description, color, fields = [], mentions = [] }) {
  if (discord) {
    const details = fields
      .map(({ name, value }) => `${name}: ${value}`)
      .join(". ");
    const simpleText = `🦹 rob: ${description || title}${details ? ` ${details}.` : ""}`;
    return sock.sendMessage(jid, { text: simpleText, mentions }, { quoted: msg });
  }
  return sock.sendMessage(jid, { text, mentions }, { quoted: msg });
}

export default {
  name: "rob",
  description: "Rob another user — 55% success rate (45-min cooldown)",
  category: "economy",
  cooldown: 6,
  usage: ".rob @user",
  checkJail: true,

  async run({ sock, msg, sender, args, discord }) {
    if (!await requireRegistration(sock, msg, sender)) return;

    const jid = msg.key.remoteJid;

    const discordTargetId = discord?.message?.mentions?.users?.first?.()?.id;
    const targetJid = discordTargetId
      ? `discord:${discordTargetId}`
      : msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0]
      || (args[0]?.match(/^[0-9]+$/) ? `${args[0]}@s.whatsapp.net` : null);

    if (!targetJid) {
      return robReply({
        sock, jid, msg, discord,
        title: "🦹 Robbery",
        description: "Choose a registered player to rob.",
        color: "#E74C3C",
        fields: [
          { name: "Usage", value: ".rob @user", inline: true },
          { name: "Success rate", value: "55%", inline: true },
          { name: "Requirement", value: "Active gun", inline: true },
        ],
        text:
`📖 *Usage*   :: *.rob @user*`

      });
    }

    if (sender === targetJid) {
      return robReply({
        sock, jid, msg, discord,
        title: "🚫 Robbery Blocked",
        description: "You cannot rob yourself.",
        color: "#E67E22",
        text: "❌ You can't rob yourself!",
      });
    }

    if (!await isRegistered(targetJid)) {
      return robReply({
        sock, jid, msg, discord,
        title: "🚫 Robbery Blocked",
        description: "That player is not registered.",
        color: "#E67E22",
        text: "That player is not registered.",
      });
    }

    const robber = await getUser(sender);
    const now    = Date.now();

    if (!hasActiveGun(robber, now)) {
      return robReply({
        sock, jid, msg, discord,
        title: "🔫 Robbery Blocked",
        description: "You need an active gun before you can rob another player.",
        color: "#E67E22",
        text:
`you have no gun buy one from *shop*,gun will be active for 3days.`
      });
    }

    const cd     = 45 * 60 * 1000;

    if (now - (robber.lastRob || 0) < cd) {
      const remaining = cd - (now - robber.lastRob);
      const minutes   = Math.floor(remaining / (60 * 1000));
      return robReply({
        sock, jid, msg, discord,
        title: "🕶️ Robbery Cooldown",
        description: `Lay low for ${minutes} minutes before trying again.`,
        color: "#E67E22",
        text:
`╭─❀「 🦹 *𝐑𝐎𝐁* 」❀─╮
│ ⏳ *Result*  :: *HIDING 🔴*
│ 🍃 *Flavour* :: _身を隠せ！警察が来るぞ！_
│
│ 🕐 *Next*    :: *${minutes}m remaining*
│
│ 😤 *Lay low for now...*
╰───────────────❀`
      });
    }

    const target = await getUser(targetJid);

    // Check staff immunity — cannot be robbed
    if (target.staffImmunity) {
      return robReply({
        sock, jid, msg, discord,
        title: "🛡️ Robbery Blocked",
        description: "This player is protected by staff immunity.",
        color: "#3498DB",
        text:
`This user has staff immunity so they can't be robbed! `
      });
    }

    // Check rob charm
    if (target.robShieldExpiry && target.robShieldExpiry > Date.now()) {
      const minsLeft = Math.ceil((target.robShieldExpiry - Date.now()) / 60000);
      return robReply({
        sock, jid, msg, discord,
        title: "🧿 Robbery Blocked",
        description: `The target's Rob Charm is active for another ${minsLeft} minutes.`,
        color: "#3498DB",
        text:
`That user has a rob charm and cannot be robbed`
      });
    }

    if (target.money < 100) {
      return robReply({
        sock, jid, msg, discord,
        title: "🚫 Robbery Aborted",
        description: `The target is broke (${fmt(target.money)}).`,
        color: "#95A5A6",
        text:

`that user is broke and cannot be robbed lol useless.`
      });
    }

    const amount  = Math.min(10000, Math.floor(Math.random() * (target.money * 0.3)) + 100);
    const success = Math.random() > 0.45;
    const targetId = discordTargetId || targetJid.split("@")[0];
    const tag = discordTargetId ? `<@${discordTargetId}>` : `@${targetId}`;
    const mentions = discordTargetId ? [`discord:${discordTargetId}`] : [targetJid];

    robber.lastRob = now;

    if (success) {
      target.money -= amount;
      robber.money += amount;
      await saveUser(sender, robber);
      await saveUser(targetJid, target);
      await addHistory(sender,    "rob",        amount,  `Robbed ${target.name}`);
      await addHistory(targetJid, "rob_victim", -amount, `Robbed by ${robber.name}`);

      return robReply({
        sock, jid, msg, discord,
        title: "🦹 Robbery Successful!",
        description: `${tag} was robbed successfully.`,
        color: "#2ECC71",
        fields: [
          { name: "Target", value: tag, inline: true },
          { name: "Stolen", value: `+${fmt(amount)}`, inline: true },
        ],
        mentions,
        text:
`you robbed *${tag}* and got away with :: *+${fmt(amount)}*`
      });
    } else {
      const fine   = Math.floor(amount * 0.7);
      robber.money = Math.max(0, robber.money - fine);
      robber.jailed = true;
      robber.jailUntil = Date.now() + 10 * 60 * 1000;
      await saveUser(sender, robber);
      await jailUser(sender, 10 * 60 * 1000);
      await addHistory(sender, "rob", -fine, `Rob failed — fined $${fine.toLocaleString()}`);

      return robReply({
        sock, jid, msg, discord,
        title: "🚓 Robbery Failed!",
        description: "The robber was fined and jailed for 10 minutes.",
        color: "#E74C3C",
        fields: [
          { name: "Fine (penalty)", value: `🪙 ${fmt(fine)}`, inline: true },
        ],
        mentions: discordTargetId
          ? [`discord:${discord.message.author.id}`, `discord:${discordTargetId}`]
          : mentions,
        text:
`You were caught, fined *-${fmt(fine)}*, and jailed for 10 minutes.`
      });
    }
  }
};
