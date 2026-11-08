/**
 * KELIN MD — Economy database (MongoDB-backed)
 * All economy / staff plugins import from here.
 */
import { createHash } from "node:crypto";
import { getDb } from "../../lib/mongo.mjs";
import { findUserByIdentity, economyAccountId } from "../../lib/identity.mjs";
import { BASE_BANK_LIMIT, STARTING_MONEY } from "./currency.js";
import { invalidateAccountIdentityCache } from "../../lib/accountIdentity.mjs";

export const DEFAULTS = {
  name:          "User",
  money:         STARTING_MONEY,
  bank:          0,
  bankLimit:     BASE_BANK_LIMIT,
  bankUpgradeLevel: 0,
  orbs:          0,           // premium currency earned from dig/fish/events
  diamonds:      0,           // rare currency earned from lucky activities
  membershipTier: "none",
  isPremium:     false,
  genesisCrystals: 0,
  membershipCashGranted: 0,
  membershipCrystalsGranted: 0,
  level:         1,
  xp:            0,
  bio:           "",
  profileBackground: null,
  profileFrame:   null,
  age:           null,
  birthday:      null,
  inventory:     [],
  history:       [],          // last 10 transactions [{type,amount,desc,ts}]
  lastDaily:     0,
  lastWork:      0,
  lastRest:      0,
  job:           null,        // current job key, null = unemployed
  fired:         false,       // true when fired, must pick new job
  lastJobChange: 0,           // timestamp of last job pick/change
  energy:        100,         // work stamina, clamped to 0..100
  workXp:        0,           // career-only XP, separate from RPG XP
  completedShifts: 0,
  workLastEvent: null,
  lastWorkPaystub: null,
  lastCrime:     0,
  lastRob:       0,
  lastDig:       0,
  lastFish:      0,
  lastGamble:    0,
  lastBet:       0,
  lastBeg:       0,
  lastSlots:     0,
  lastScratch:   0,
  jail:          false,
  jailed:        false,
  jailUntil:     null,
  shame:         0,           // times shamed by others
  shameBy:       null,        // last person who shamed you
  loan:          null,        // { amount, due, active, interest }
  afk:           null,        // { active, message, since }
  staffLevel:    0,           // 0=user 1=mod 2=staff 3=admin
  isPremium:     false,
  staffImmunity: false,
  registered:    false,
  registeredAt:  null,
  banned:        false,
  bannedReason:  null,
  bannedBy:      null,
  bannedAt:      null,
};

// ─── Core CRUD ────────────────────────────────────────────────────────────────

export async function getUser(id) {
  const db   = await getDb();
  // Wallet reset migrations must never run as a side effect of reading a user.
  const user = await findUserByIdentity(id);
  if (!user) return { ...DEFAULTS };
  const { _id, ...rest } = user;
  const merged = { ...DEFAULTS, ...rest };
  merged.totalWealth = Number(merged.money || 0) + Number(merged.bank || 0);
  // Retire the old card/service entries from existing inventories. Bank
  // access is now available by default and capacity is controlled by tiers.
  merged.inventory = (Array.isArray(merged.inventory) ? merged.inventory : [])
    .filter((item) => !["bank_card", "bank_limit_upgrade"].includes(item));

  // Snapshot the numeric balance fields at read time.
  // saveUser uses these to compute deltas and apply them with $inc (atomic),
  // which prevents two overlapping commands from overwriting each other's changes.
  merged._snap = {
    money:    merged.money    ?? 0,
    bank:     merged.bank     ?? 0,
    xp:       merged.xp       ?? 0,
    diamonds: merged.diamonds ?? 0,
    orbs:     merged.orbs     ?? 0,
    workXp:   merged.workXp   ?? 0,
    completedShifts: merged.completedShifts ?? 0,
  };
  return merged;
}

const WALLET_CAP = 500_000_000_000; // 500 Billion max in wallet

// Fields that must be updated atomically with $inc to prevent race conditions.
// Every other field is safe to $set because it isn't modified by concurrent commands.
const ATOMIC_FIELDS = new Set([
  "money", "bank", "xp", "diamonds", "orbs",
  "completedShifts", "workXp",
]);

// Cooldown timestamp fields — updated with $max so a stale save from a concurrent
// command can never overwrite a more-recent timestamp written by the command that
// actually set the cooldown. This prevents race conditions like: user uses .slots
// (sets lastSlots=T), then .bet saves (with lastSlots=0 from a pre-slots getUser
// snapshot) and wipes the cooldown — or accidentally restores a stale timestamp.
const COOLDOWN_FIELDS = new Set([
  "lastDaily",
  "lastWork", "lastJobChange",
  "lastRest",
  "lastCrime", "lastRob",
  "lastDig", "lastFish",
  "lastGamble", "lastBet",
  "lastBeg", "lastSlots", "lastScratch",
]);

// Monotonic fields — updated with $max so they can only ever increase via saveUser.
// level belongs here: legitimate level-ups only go up, and stale $set writes from
// commands that loaded a user before a level-up must never overwrite a higher value.
// (Admins can still force-set level directly via setPlayerFields which uses $set.)
const MONOTONIC_FIELDS = new Set(["level"]);

export async function saveUser(id, data) {
  const db = await getDb();
  id = await economyAccountId(id);
  // Strip _id and _snap — neither should be stored in MongoDB
  const { _id, _snap, ...safeData } = data;
  // Auction holds are managed with targeted Mongo updates. Never overwrite
  // them from an economy command's potentially stale whole-user snapshot.
  delete safeData.auctionHolds;
  // This is derived data, never a caller's stale snapshot.
  delete safeData.totalWealth;

  // ── WALLET_CAP enforcement (adjust in-memory before computing deltas) ──────
  if ((safeData.money ?? 0) > WALLET_CAP) {
    const excess   = safeData.money - WALLET_CAP;
    safeData.money = WALLET_CAP;
    safeData.bank  = (safeData.bank ?? 0) + excess;
  }

  // ── Build update operation ─────────────────────────────────────────────────
  if (_snap) {
    // Existing user: use $inc for numeric fields (race-condition-safe),
    // and $set for everything else (timestamps, flags, arrays, strings, etc.)
    const incOp = {};
    const maxOp = {};
    const setOp = {};

    for (const [key, value] of Object.entries(safeData)) {
      if (ATOMIC_FIELDS.has(key)) {
        const delta = (value ?? 0) - (_snap[key] ?? 0);
        if (delta !== 0) incOp[key] = delta;
      } else if (COOLDOWN_FIELDS.has(key)) {
        // Use $max so a stale snapshot from a concurrent command can never
        // overwrite a more-recent cooldown timestamp written by the command
        // that actually triggered the cooldown.
        maxOp[key] = value ?? 0;
      } else if (MONOTONIC_FIELDS.has(key)) {
        // Use $max so level can only ever increase via saveUser.
        // Stale saves from commands that loaded before a level-up can never
        // overwrite a higher level already written to the DB.
        maxOp[key] = value ?? 0;
      } else {
        setOp[key] = value;
      }
    }

    const wealthDelta = (incOp.money || 0) + (incOp.bank || 0);
    if (wealthDelta !== 0) incOp.totalWealth = wealthDelta;
    const update = {};
    if (Object.keys(incOp).length > 0) update.$inc = incOp;
    if (Object.keys(maxOp).length > 0) update.$max = maxOp;
    if (Object.keys(setOp).length > 0) update.$set = setOp;
    if (Object.keys(update).length === 0) return; // nothing changed

    await db.collection("users").updateOne({ _id: id }, update, { upsert: true });

    if ((incOp.money ?? 0) < 0 || (incOp.bank ?? 0) < 0 || (_snap.money ?? 0) < 0 || (_snap.bank ?? 0) < 0) {
      // Clamp balances and derive wealth from the live document, not a stale
      // Discord snapshot. This also repairs legacy rows missing totalWealth.
      await db.collection("users").updateOne(
        { _id: id },
        [{ $set: {
          money: { $max: [{ $ifNull: ["$money", 0] }, 0] },
          bank:  { $max: [{ $ifNull: ["$bank", 0] }, 0] },
          totalWealth: { $add: [
            { $max: [{ $ifNull: ["$money", 0] }, 0] },
            { $max: [{ $ifNull: ["$bank", 0] }, 0] },
          ] },
        }}]
      );
    }
  } else {
    // New user (no snapshot) — safe to $set everything since nobody else has this doc yet
    safeData.totalWealth = Number(safeData.money || 0) + Number(safeData.bank || 0);
    await db.collection("users").updateOne(
      { _id: id },
      { $set: safeData },
      { upsert: true }
    );
  }
}

/**
 * Atomically claim a work shift.
 *
 * The cooldown, energy requirement, wallet payout, career XP, and shift count
 * are all part of one conditional update. This prevents duplicate paychecks
 * when a user sends .work twice before the first database write finishes.
 */
export async function claimWorkShift(id, {
  jobKey,
  now,
  cooldownMs,
  energyCost,
  netPay,
  xp,
  workXp,
  gross,
  tax,
  eventKey,
  eventLabel,
  eventAmount,
  historyDescription,
}) {
  const db = await getDb();
  const result = await db.collection("users").findOneAndUpdate(
    {
      _id: id,
      registered: true,
      job: jobKey,
      $or: [
        { lastWork: { $exists: false } },
        { lastWork: { $lte: now - cooldownMs } },
      ],
      $and: [
        {
          $or: [
            { energy: { $exists: false } },
            { energy: { $gte: energyCost } },
          ],
        },
      ],
    },
    [
      {
        $set: {
          money: { $add: [{ $ifNull: ["$money", 0] }, netPay] },
          xp: { $add: [{ $ifNull: ["$xp", 0] }, xp] },
          workXp: { $add: [{ $ifNull: ["$workXp", 0] }, workXp] },
          completedShifts: { $add: [{ $ifNull: ["$completedShifts", 0] }, 1] },
          lastWork: now,
          energy: { $subtract: [{ $ifNull: ["$energy", 100] }, energyCost] },
          workLastEvent: { key: eventKey, label: eventLabel, amount: eventAmount, ts: now },
          lastWorkPaystub: {
            jobKey,
            gross,
            net: netPay,
            tax,
            event: eventLabel,
            description: historyDescription,
            ts: now,
          },
        },
      },
    ],
    {
      returnDocument: "after",
      includeResultMetadata: false,
    }
  );
  return result || null;
}

/**
 * Atomically consume a rest cooldown and restore work energy.
 */
export async function restoreWorkEnergy(id, now, cooldownMs, amount) {
  const db = await getDb();
  const result = await db.collection("users").findOneAndUpdate(
    {
      _id: id,
      registered: true,
      $and: [
        {
          $or: [
            { energy: { $exists: false } },
            { energy: { $lt: 100 } },
          ],
        },
        {
          $or: [
            { lastRest: { $exists: false } },
            { lastRest: { $lte: now - cooldownMs } },
          ],
        },
      ],
    },
    [
      {
        $set: {
          energy: { $min: [{ $add: [{ $ifNull: ["$energy", 100] }, amount] }, 100] },
          lastRest: now,
        },
      },
    ],
    {
      returnDocument: "after",
      includeResultMetadata: false,
    }
  );
  if (!result) return null;
  const energy = Math.max(0, Math.min(100, Number(result.energy ?? 100)));
  const filled = Math.round(energy / 10);
  return {
    ...result,
    energy,
    energyBar: `${"█".repeat(filled)}${"░".repeat(10 - filled)} ${Math.round(energy)}%`,
  };
}

/**
 * Atomically start an investment.
 * This prevents two simultaneous commands from creating an investment with
 * stale balances or replacing each other's active investment.
 */
export async function startInvestment(id, investment, amount) {
  const db = await getDb();
  return db.collection("users").findOneAndUpdate(
    {
      _id: id,
      money: { $gte: amount },
      $or: [
        { activeInvestment: { $exists: false } },
        { activeInvestment: null },
      ],
    },
    {
      $inc: { money: -amount },
      $set: { activeInvestment: investment },
    },
    { returnDocument: "after" }
  );
}

/**
 * Atomically claim a matured investment.
 * The active investment fields are part of the filter, so only one
 * concurrent collect can match and receive the payout.
 */
export async function collectInvestment(id, investment, payout) {
  const db = await getDb();
  return db.collection("users").findOneAndUpdate(
    {
      _id: id,
      "activeInvestment.plan": investment.plan,
      "activeInvestment.amount": investment.amount,
      "activeInvestment.startedAt": investment.startedAt,
    },
    {
      $inc: { money: payout, xp: 20 },
      $unset: { activeInvestment: "" },
    },
    { returnDocument: "after" }
  );
}

export async function getAllUsers() {
  const db = await getDb();
  return db.collection("users").find({ registered: true }).toArray();
}

// ─── Registration ─────────────────────────────────────────────────────────────

export async function isRegistered(id) {
  const db   = await getDb();
  const user = await findUserByIdentity(id, { projection: { registered: 1 } });
  return !!(user?.registered);
}

export async function registerUser(id, name) {
  const db = await getDb();
  id = await economyAccountId(id);
  const { name: _n, registered: _r, registeredAt: _ra, ...insertDefaults } = DEFAULTS;
  await db.collection("users").updateOne(
    { _id: id },
    {
      $setOnInsert: { ...insertDefaults, money: 100_000 },
      $set: { name: name || "User", registered: true, registeredAt: new Date().toISOString() },
    },
    { upsert: true }
  );
  invalidateAccountIdentityCache(db);
}

/** Convenience: send a "you need to register" message and return false */
export async function requireRegistration(sock, msg, sender) {
  const ok = await isRegistered(sender);
  if (!ok) {
    await sock.sendMessage(
      msg.key.remoteJid,
      { text: "❌ You need to register first!\n\nUse *.register <your_name>* to create your account." },
      { quoted: msg }
    );
  }
  return ok;
}

// ─── Transaction history ──────────────────────────────────────────────────────

/**
 * Append a transaction to the user's history (capped at 10).
 * @param {string} id      – sender JID
 * @param {string} type    – e.g. "daily", "work", "rob", "deposit", ...
 * @param {number} amount  – positive = earned, negative = lost
 * @param {string} desc    – short human-readable description
 */
export async function addHistory(id, type, amount, desc) {
  const db = await getDb();
  id = await economyAccountId(id);
  const entry = { type, amount, desc, ts: Date.now() };
  await db.collection("users").updateOne(
    { _id: id },
    {
      $push: {
        history: {
          $each:  [entry],
          $slice: -10,      // keep last 10
        },
      },
    }
  );
}

/**
 * Add (or subtract) economy money from a user's cash balance.
 * Safe with upsert:false — won't create a user that doesn't exist.
 */
export async function addMoney(id, amount) {
  const db = await getDb();
  id = await economyAccountId(id);
  await db.collection("users").updateOne(
    { _id: id },
    { $inc: { money: amount } }
  );
}

export async function debitWalletIfAvailable(id, amount) {
  const debit = Math.trunc(Number(amount));
  if (!Number.isSafeInteger(debit) || debit <= 0) return null;

  const db = await getDb();
  id = await economyAccountId(id);
  const startingMoney = DEFAULTS.money;
  const result = await db.collection("users").findOneAndUpdate(
    {
      _id: id,
      registered: true,
      $expr: {
        $gte: [{ $ifNull: ["$money", startingMoney] }, debit],
      },
    },
    [
      {
        $set: {
          money: {
            $subtract: [{ $ifNull: ["$money", startingMoney] }, debit],
          },
          totalWealth: {
            $add: [
              { $subtract: [{ $ifNull: ["$money", startingMoney] }, debit] },
              { $ifNull: ["$bank", 0] },
            ],
          },
        },
      },
    ],
    { returnDocument: "after", includeResultMetadata: false },
  );
  return result ? { money: result.money, bank: result.bank || 0 } : null;
}

function auctionHoldPath(auctionId) {
  const key = createHash("sha256").update(String(auctionId)).digest("hex").slice(0, 32);
  return `auctionHolds.${key}`;
}

export async function setAuctionHold(id, auctionId, amount, expiresAt) {
  const holdId = String(auctionId || "").trim();
  const bid = Math.trunc(Number(amount));
  const until = Math.trunc(Number(expiresAt));
  if (!holdId || !Number.isSafeInteger(bid) || bid <= 0 || !Number.isFinite(until)) return false;

  const db = await getDb();
  id = await economyAccountId(id);
  const result = await db.collection("users").updateOne(
    { _id: id, registered: true },
    {
      $set: {
        [auctionHoldPath(holdId)]: {
          auctionId: holdId,
          amount: bid,
          expiresAt: until,
        },
      },
    },
  );
  return result.matchedCount > 0;
}

export async function clearAuctionHold(id, auctionId) {
  const holdId = String(auctionId || "").trim();
  if (!holdId) return false;
  const db = await getDb();
  id = await economyAccountId(id);
  const result = await db.collection("users").updateOne(
    { _id: id },
    { $unset: { [auctionHoldPath(holdId)]: "" } },
  );
  return result.matchedCount > 0;
}

/**
 * Award rare Diamonds to an in-memory user when a lucky activity hits.
 * Callers persist the user with saveUser after adding the reward.
 */
export function maybeAwardDiamonds(user, chance = 0.02, min = 1, max = 2) {
  if (Math.random() >= chance) return 0;
  const amount = Math.floor(Math.random() * (max - min + 1)) + min;
  user.diamonds = (user.diamonds || 0) + amount;
  return amount;
}

// ─── Level-up helper ─────────────────────────────────────────────────────────

/**
 * XP required to level up FROM the given level (same formula as profile.js).
 */
const _xpForLevel = (level) => (level ?? 1) * 100;

/**
 * Check and apply any level-ups earned by current XP.
 * Mutates `user` in-place (level, xp fields).
 * Returns { leveled, startLevel, newLevel }.
 *
 * Call this BEFORE saveUser so the updated level is persisted correctly.
 */
export function checkLevelUp(user) {
  const startLevel = user.level ?? 1;
  while ((user.xp ?? 0) >= _xpForLevel(user.level ?? 1)) {
    user.xp    = (user.xp ?? 0) - _xpForLevel(user.level ?? 1);
    user.level = (user.level ?? 1) + 1;
  }
  return {
    leveled:    user.level > startLevel,
    startLevel,
    newLevel:   user.level ?? 1,
  };
}

/**
 * Given a raw cumulative XP total, compute the correct level and remainder XP.
 * Used by the level repair command to reconstruct level from accumulated XP.
 * @param {number} totalXp  – cumulative XP ever earned
 * @returns {{ level: number, xp: number }}
 */
export function levelFromTotalXp(totalXp) {
  let level = 1;
  let xp    = totalXp;
  while (xp >= _xpForLevel(level)) {
    xp    -= _xpForLevel(level);
    level += 1;
  }
  return { level, xp };
}

/**
 * Repair a single user's level.
 *
 * Strategy:
 *  1. Reconstruct total XP from the current remainder + XP consumed to reach
 *     the stored level  (sum of thresholds 1…level-1).
 *  2. Re-run levelFromTotalXp to get the authoritative level.
 *  3. Always take the MAX of (stored level, recalculated level) so we never
 *     reduce a legitimately high level.
 *
 * Returns { oldLevel, newLevel, changed }.
 */
export async function repairUserLevel(id) {
  const db   = await getDb();
  const doc  = await db.collection("users").findOne({ _id: id }, { projection: { level: 1, xp: 1 } });
  if (!doc) return null;

  const storedLevel = doc.level ?? 1;
  const storedXp    = doc.xp    ?? 0;

  // XP consumed to reach storedLevel = sum of thresholds for levels 1 … storedLevel-1
  let consumedXp = 0;
  for (let l = 1; l < storedLevel; l++) consumedXp += _xpForLevel(l);

  const totalXp = consumedXp + storedXp;
  const { level: recalcLevel, xp: recalcXp } = levelFromTotalXp(totalXp);

  const correctLevel = Math.max(storedLevel, recalcLevel);
  const correctXp    = correctLevel === recalcLevel ? recalcXp : storedXp;

  if (correctLevel === storedLevel) {
    return { oldLevel: storedLevel, newLevel: storedLevel, changed: false };
  }

  await db.collection("users").updateOne(
    { _id: id },
    { $set: { level: correctLevel, xp: correctXp } }
  );
  return { oldLevel: storedLevel, newLevel: correctLevel, changed: true };
}

/**
 * Repair levels for ALL registered users.
 * Returns { fixed, total } counts.
 */
export async function repairAllLevels() {
  const db    = await getDb();
  const users = await db.collection("users").find({ registered: true }, { projection: { _id: 1 } }).toArray();
  let fixed   = 0;
  for (const { _id } of users) {
    const result = await repairUserLevel(_id);
    if (result?.changed) fixed++;
  }
  return { fixed, total: users.length };
}

// ─── Staff / Mod ──────────────────────────────────────────────────────────────

/**
 * Set a user's staff level.
 * 0 = user, 1 = mod, 2 = staff, 3 = admin
 */
export async function setStaffLevel(id, level) {
  const db = await getDb();
  const user = await findUserByIdentity(id);
  if (!user || user.registered !== true) return false;

  const result = await db.collection("users").updateOne(
    { _id: user._id, registered: true },
    { $set: { staffLevel: level } },
  );
  return result.matchedCount === 1;
}

export async function removeStaffLevel(id) {
  return setStaffLevel(id, 0);
}

export async function getStaffMembers() {
  const db = await getDb();
  return db.collection("users").find(
    {
      $or: [
        { staffLevel: { $gte: 1 } },
        { staffLevel: { $in: ["1", "2", "3", "99"] } },
      ],
    },
    { projection: { _id: 1, name: 1, staffLevel: 1 } }
  ).toArray();
}

// ─── Premium ──────────────────────────────────────────────────────────────────

export async function setPremium(id, value) {
  const db = await getDb();
  await db.collection("users").updateOne(
    { _id: id },
    { $set: { isPremium: value } },
    { upsert: true }
  );
}

// ─── Jail ─────────────────────────────────────────────────────────────────────

/**
 * @param {string} id
 * @param {number} durationMs  0 = indefinite
 */
export async function jailUser(id, durationMs = 0) {
  const db       = await getDb();
  const jailUntil = durationMs > 0 ? Date.now() + durationMs : null;
  await db.collection("users").updateOne(
    { _id: id },
    { $set: { jailed: true, jailUntil } },
    { upsert: true }
  );
}

export async function unjailUser(id) {
  const db = await getDb();
  await db.collection("users").updateOne(
    { _id: id },
    { $set: { jailed: false, jailUntil: null } }
  );
}

// ─── Staff Immunity ───────────────────────────────────────────────────────────

export async function setStaffImmunity(id, value) {
  const db = await getDb();
  await db.collection("users").updateOne(
    { _id: id },
    { $set: { staffImmunity: value } },
    { upsert: true }
  );
}

// ─── Admin helpers ────────────────────────────────────────────────────────────

export async function deletePlayer(id) {
  const db = await getDb();
  await db.collection("users").deleteOne({ _id: id });
}

export async function resetPlayer(id) {
  const db   = await getDb();
  const user = await getUser(id);
  const { name, registered, registeredAt, staffLevel, isPremium, staffImmunity } = user;
  // Preserve identity fields, wipe economy
  await db.collection("users").updateOne(
    { _id: id },
    {
      $set: {
        ...DEFAULTS,
        name, registered, registeredAt, staffLevel, isPremium, staffImmunity,
        websiteSessionRevokedAt: Date.now(),
        money: STARTING_MONEY, bank: 0, bankLimit: BASE_BANK_LIMIT, bankUpgradeLevel: 0,
        xp: 0, level: 1, inventory: [], history: [],
        websiteBanned: true,
        websiteBanReason: "Account reset by staff",
        websiteBannedAt: new Date(),
        websiteSessionRevokedAt: new Date(),
      },
    }
  );
}

/**
 * Set individual player stat fields.
 * @param {string} id
 * @param {object} fields – e.g. { money: 5000, level: 10 }
 */
export async function setPlayerFields(id, fields) {
  const db = await getDb();
  const user = await findUserByIdentity(id, { projection: { _id: 1, registered: 1 } });
  if (!user || user.registered !== true) return false;
  const { totalWealth: _ignoredTotalWealth, ...safeFields } = fields;
  const result = await db.collection("users").updateOne(
    { _id: user._id, registered: true },
    [
      { $set: safeFields },
      {
        $set: {
          totalWealth: {
            $add: [
              { $ifNull: ["$money", 0] },
              { $ifNull: ["$bank", 0] },
            ],
          },
        },
      },
    ],
  );
  return result.matchedCount === 1;
}

// ─── Ban system ───────────────────────────────────────────────────────────────

/** Ban a user — blocks all bot commands. */
export async function banUser(id, reason = "No reason given", bannedBy = "Owner") {
  const db = await getDb();
  await db.collection("users").updateOne(
    { _id: id },
    { $set: { banned: true, bannedReason: reason, bannedBy, bannedAt: new Date().toISOString() } },
    { upsert: true }
  );
}

/** Lift a ban. */
export async function unbanUser(id) {
  const db = await getDb();
  await db.collection("users").updateOne(
    { _id: id },
    {
      $set: {
        banned: false,
        bannedReason: null,
        bannedBy: null,
        bannedAt: null,
      },
    },
  );
}

/** Restore AIDORU website access without changing bot ban status. */
export async function restoreWebsiteUser(id) {
  const db = await getDb();
  await db.collection("users").updateOne(
    { _id: id },
    {
      $set: {
        websiteBanned: false,
        websiteBanReason: null,
        websiteBannedAt: null,
        // Force a fresh website login after restoration.
        websiteSessionRevokedAt: new Date(),
      },
    },
  );
}

/**
 * Find a registered user by their in-game name (case-insensitive, exact match).
 * Returns { _id, name, ... } or null if not found.
 * If multiple users share the same name, returns the first match.
 */
export async function findUserByName(name) {
  const db = await getDb();
  return db.collection("users").findOne(
    { registered: true, name: { $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" } },
    { projection: { _id: 1, name: 1 } }
  );
}

/** Quick banned check (projection-only — no full user load). */
export async function isBanned(id) {
  const db   = await getDb();
  const user = await db.collection("users").findOne({ _id: id }, { projection: { banned: 1 } });
  return !!(user?.banned);
}
