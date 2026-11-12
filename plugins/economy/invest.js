/**
 * KELIN MD — .invest
 * High-Risk Economy Investment Command
 */
import {
  getUser,
  requireRegistration,
  addHistory,
  startInvestment,
  collectInvestment,
} from "./database.js";
import { economyWinRate } from "../../lib/economyOdds.mjs";

const MAX_INVEST = 90_000_000; // 90 million cap per investment

const PLANS = {
  short: {
    label:      "Short-Term",
    emoji:      "⚡",
    duration:   5 * 60 * 1000,      // 5 minutes
    minRet:     0.03,               // 3% min return
    maxRet:     0.10,               // 10% max return
    lossChance: 0.90,               // 90% crash rate
    minLoss:    0.30,               // 30% min loss
    maxLoss:    0.50,               // 50% max loss
    minAmt:     1000,
  },
  medium: {
    label:      "Medium-Term",
    emoji:      "📊",
    duration:   30 * 60 * 1000,     // 30 minutes
    minRet:     0.15,               // 15% min return
    maxRet:     0.35,               // 35% max return
    lossChance: 0.90,               // 90% crash rate
    minLoss:    0.40,               // 40% min loss
    maxLoss:    0.70,               // 70% max loss
    minAmt:     5000,
  },
  long: {
    label:      "Long-Term",
    emoji:      "🏦",
    duration:   2 * 60 * 60 * 1000, // 2 hours
    minRet:     0.30,               // 30% min return
    maxRet:     0.80,               // 80% max return
    lossChance: 0.90,               // 90% crash rate
    minLoss:    0.60,               // 60% min loss
    maxLoss:    0.85,               // 85% max loss
    minAmt:     25000,
  },
};

function parseAmount(input, userMoney) {
  if (!input) return NaN;
  const str = input.toLowerCase().trim();
  if (str === "all" || str === "max") return userMoney;
  if (str === "half") return Math.floor(userMoney / 2);

  const match = str.match(/^(\d+(?:\.\d+)?)\s*([kmb])?$/);
  if (!match) return parseInt(str.replace(/\D/g, ""), 10);

  let num = parseFloat(match[1]);
  const unit = match[2];
  if (unit === "k") num *= 1_000;
  if (unit === "m") num *= 1_000_000;
  if (unit === "b") num *= 1_000_000_000;

  return Math.floor(num);
}

function fmtMs(ms) {
  const hrs  = Math.floor(ms / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  if (hrs > 0)  return `${hrs}h ${mins}m`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

export default {
  name: "invest",
  aliases: ["investment", "stock"],
  category: "economy",
  cooldown: 6,
  description: "Invest money in high-risk markets",
  usage: ".invest <amount> <short|medium|long>  |  .invest collect  |  .invest status",
  checkJail: true,

  async run({ sock, msg, sender, args }) {
    if (!await requireRegistration(sock, msg, sender)) return;

    const jid   = msg.key.remoteJid;
    const reply = (t) => sock.sendMessage(jid, { text: t }, { quoted: msg });
    const now   = Date.now();
    const user  = await getUser(sender);

    const sub = (args[0] || "").toLowerCase();

    // ── STATUS ────────────────────────────────────────────────────────────
    if (sub === "status") {
      const inv = user.activeInvestment;
      if (!inv) return reply("📊 You have no active investment.\n\nUse *.invest <amount> <plan>* to start one.");

      const plan      = PLANS[inv.plan];
      const maturesAt = inv.startedAt + plan.duration;
      const matured   = now >= maturesAt;

      return reply(
`📊 *INVESTMENT STATUS*

${plan.emoji} Plan    : ${plan.label}
💰 Amount  : $${inv.amount.toLocaleString()}
📅 Started : ${new Date(inv.startedAt).toLocaleTimeString()}
⏰ Matures : ${matured ? "*NOW — Ready to collect!*" : `in ${fmtMs(maturesAt - now)}`}

${matured ? "✅ Use *.invest collect* to collect your returns!" : "⏳ Come back when the timer is up."}`
      );
    }

    // ── COLLECT ───────────────────────────────────────────────────────────
    if (sub === "collect") {
      const inv = user.activeInvestment;
      if (!inv) return reply("❌ You have no active investment to collect.");

      const plan      = PLANS[inv.plan];
      const maturesAt = inv.startedAt + plan.duration;

      if (now < maturesAt) {
        return reply(`⏳ Your investment hasn't matured yet!\n\nCome back in *${fmtMs(maturesAt - now)}*.`);
      }

      const lost = Math.random() < (1 - economyWinRate(1 - plan.lossChance, user));
      let payout, net, statusMsg;

      if (lost) {
        // 15% chance of a TOTAL WIPEOUT on loss
        const isTotalWipeout = Math.random() < 0.15;
        const lossPct = isTotalWipeout ? 1.0 : plan.minLoss + Math.random() * (plan.maxLoss - plan.minLoss);
        const lostAmt = Math.floor(inv.amount * lossPct);
        payout = Math.max(0, inv.amount - lostAmt);
        net    = -lostAmt;

        statusMsg = isTotalWipeout
          ? `💥 *TOTAL BANKRUPT!* Market liquidated your portfolio completely! -$${inv.amount.toLocaleString()} (-100%)`
          : `📉 *MARKET CRASH!* Lost ${(lossPct * 100).toFixed(1)}% — -$${Math.abs(net).toLocaleString()}`;
      } else {
        // 5% chance of a MOONSHOT spike
        const isMoonshot = Math.random() < 0.05;
        const returnPct  = isMoonshot ? 2.0 + Math.random() : plan.minRet + Math.random() * (plan.maxRet - plan.minRet);
        const profit     = Math.floor(inv.amount * returnPct);
        payout = inv.amount + profit;
        net    = profit;

        statusMsg = isMoonshot
          ? `🚀 *BULL RUN MOONSHOT!* +$${net.toLocaleString()} (${(net / inv.amount * 100).toFixed(1)}% return)`
          : `📈 *PROFIT!* +$${net.toLocaleString()} (${(net / inv.amount * 100).toFixed(1)}% return)`;
      }

      const updatedUser = await collectInvestment(sender, inv, payout);
      if (!updatedUser) {
        return reply("⚠️ This investment was already collected or changed. Check `.invest status` for your current investment.");
      }
      await addHistory(sender, "invest", net, `Investment collected: ${inv.plan} plan`);

      return reply(
`${plan.emoji} *INVESTMENT COLLECTED!*

📌 Plan   : ${plan.label}
💰 Invested: $${inv.amount.toLocaleString()}
${statusMsg}

💰 Received : $${payout.toLocaleString()}
🏦 Balance  : $${updatedUser.money.toLocaleString()}`
      );
    }

    // ── NEW INVESTMENT ────────────────────────────────────────────────────
    let planKey = PLANS[args[1]?.toLowerCase()] ? args[1].toLowerCase() : PLANS[args[0]?.toLowerCase()] ? args[0].toLowerCase() : null;
    let rawAmt = planKey === args[0]?.toLowerCase() ? args[1] : args[0];

    if (!args[0] || !planKey || !rawAmt) {
      return reply(
`🏦 *HIGH-RISK INVESTMENT*

High risk, volatile markets!

Plans:
  ⚡ *.invest <amt> short*  — 5 min  | +3–10% return  | 90% crash risk | $1k min
  📊 *.invest <amt> medium* — 30 min | +15–35% return | 90% crash risk | $5k min
  🏦 *.invest <amt> long*   — 2 hrs  | +30–80% return | 90% crash risk | $25k min

💡 Max investment: *$90,000,000* per investment
⚠️ *Warning:* Market crashes can wipe out up to 100% of your capital!

Collect with *.invest collect*.
_Only one active investment at a time._`
      );
    }

    if (user.activeInvestment) {
      const plan = PLANS[user.activeInvestment.plan];
      const maturesAt = user.activeInvestment.startedAt + plan.duration;
      return reply(`❌ You already have an active ${plan.label} investment!\n\nUse *.invest status* or collect it first with *.invest collect*.${now >= maturesAt ? "\n\n✅ It's ready to collect now!" : ""}`);
    }

    const plan   = PLANS[planKey];
    const amount = parseAmount(rawAmt, user.money);

    if (!amount || isNaN(amount)) return reply("❌ Enter a valid amount. Example: *.invest 5000 medium* or *.invest short 50k*");
    if (amount < plan.minAmt)     return reply(`❌ Minimum investment for ${plan.label} is *$${plan.minAmt.toLocaleString()}*.`);
    if (amount > MAX_INVEST)      return reply(`❌ Maximum investment is *$90,000,000* per investment.`);
    if (amount > user.money)      return reply(`❌ You only have *$${user.money.toLocaleString()}*.`);

    const updatedUser = await startInvestment(sender, {
      plan: planKey,
      amount,
      startedAt: now,
    }, amount);
    if (!updatedUser) {
      return reply("⚠️ Your balance or active investment changed while starting this investment. Please try again.");
    }

    await addHistory(sender, "invest", -amount, `Started ${planKey} investment: $${amount.toLocaleString()}`);

    return reply(
`${plan.emoji} *INVESTMENT STARTED!*

📌 Plan    : ${plan.label}
💰 Amount  : $${amount.toLocaleString()}
⏰ Matures : in ${fmtMs(plan.duration)}
📈 Potential Return : ${(plan.minRet * 100).toFixed(0)}–${(plan.maxRet * 100).toFixed(0)}%
⚠️ Crash Risk       : ${(plan.lossChance * 100).toFixed(0)}%

Come back in *${fmtMs(plan.duration)}* and use *.invest collect*!
🏦 Remaining balance: $${updatedUser.money.toLocaleString()}`
    );
  },
};
