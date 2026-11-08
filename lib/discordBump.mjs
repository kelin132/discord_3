import { getDb } from "./mongo.mjs";

export const BUMP_CHANNEL_ID = "1544619838079635527";
export const BUMP_INTERVAL_MS = 2 * 60 * 60 * 1000;
export const DISBOARD_SERVER_ID = "1533792061168423102";
const COLLECTION = "discordBumpReminders";
const REQUEST_COLLECTION = "discordBumpRequests";
const REQUEST_TTL_MS = 10 * 60 * 1000;
const timers = new Map();
let discordClient = null;

export async function findBumpiesRole(guild) {
  const cached = guild?.roles?.cache?.find(
    (entry) => entry.name.trim().toLowerCase() === "bumpies",
  );
  if (cached) return cached;
  const roles = await guild?.roles?.fetch?.().catch(() => null);
  return roles?.find(
    (entry) => entry.name.trim().toLowerCase() === "bumpies",
  ) || null;
}

function reminderKey(guildId, channelId) {
  return `${guildId}:${channelId}`;
}

function clearReminderTimer(key) {
  const timer = timers.get(key);
  if (timer) clearTimeout(timer);
  timers.delete(key);
}

async function sendReminder(document) {
  const key = reminderKey(document.guildId, document.channelId);
  clearReminderTimer(key);

  const db = getDb();
  const claimed = await db.collection(COLLECTION).findOneAndUpdate(
    {
      _id: document._id,
      dueAt: document.dueAt,
      remindedAt: { $exists: false },
    },
    { $set: { remindedAt: new Date() } },
    { returnDocument: "before" },
  );
  if (!claimed) return;

  try {
    const guild = await discordClient?.guilds.fetch(document.guildId);
    const channel = await guild?.channels.fetch(document.channelId);
    if (!channel?.isTextBased?.()) return;

    const role = await findBumpiesRole(guild);
    const content = role
      ? `<@&${role.id}> ⏰ It has been 2 hours. Please use \`/bump\` to bump this server!`
      : "⏰ It has been 2 hours. Please use `/bump` to bump this server!";

    await channel.send({
      content,
      allowedMentions: role ? { roles: [role.id] } : { parse: [] },
    });
  } catch (error) {
    console.error("[discord bump] reminder failed:", error.message);
  }
}

function scheduleReminder(document) {
  if (!discordClient || document.remindedAt) return;

  const key = reminderKey(document.guildId, document.channelId);
  clearReminderTimer(key);
  const delay = Math.max(0, new Date(document.dueAt).getTime() - Date.now());
  const timer = setTimeout(() => {
    sendReminder(document).catch((error) => {
      console.error("[discord bump] scheduled reminder failed:", error.message);
    });
  }, delay);
  timer.unref?.();
  timers.set(key, timer);
}

export async function recordBump({ guildId, channelId, userId, userName }) {
  const now = new Date();
  const dueAt = new Date(now.getTime() + BUMP_INTERVAL_MS);
  const document = {
    _id: reminderKey(guildId, channelId),
    guildId: String(guildId),
    channelId: String(channelId),
    lastBumperId: String(userId || ""),
    lastBumperName: String(userName || "A member"),
    bumpedAt: now,
    dueAt,
  };

  const db = getDb();
  await db.collection(COLLECTION).replaceOne(
    { _id: document._id },
    document,
    { upsert: true },
  );
  scheduleReminder(document);
  return dueAt;
}

export function isValidDisboardConfirmation(message) {
  if (!message?.author?.bot) return false;

  const username = String(message.author.username || "").trim().toLowerCase();
  const discriminator = String(message.author.discriminator || "").trim();
  const isDisboard =
    username === "disboard" ||
    `${username}#${discriminator}` === "disboard#2760";
  if (!isDisboard) return false;

  if (String(message.guild?.id || "") !== DISBOARD_SERVER_ID) return false;
  if (String(message.channelId || "") !== BUMP_CHANNEL_ID) return false;

  const content = String(message.content || "").replace(/\r/g, "").trim();
  return (
    content.includes("Bump done! :thumbsup:") &&
    content.includes(
      "Check it out [on DISBOARD](https://disboard.org/server/1533792061168423102).",
    )
  );
}

export async function recordBumpRequest({
  guildId,
  channelId,
  userId,
  discordId,
  userName,
}) {
  const now = new Date();
  await getDb().collection(REQUEST_COLLECTION).replaceOne(
    { _id: reminderKey(guildId, channelId) },
    {
      _id: reminderKey(guildId, channelId),
      guildId: String(guildId),
      channelId: String(channelId),
      userId: String(userId || ""),
      discordId: String(discordId || ""),
      userName: String(userName || "A member"),
      requestedAt: now,
      expiresAt: new Date(now.getTime() + REQUEST_TTL_MS),
    },
    { upsert: true },
  );
}

export async function handleDisboardConfirmation(message) {
  if (!isValidDisboardConfirmation(message)) return false;

  const db = getDb();
  const requestResult = await db.collection(REQUEST_COLLECTION).findOneAndDelete({
    _id: reminderKey(message.guild.id, message.channelId),
    expiresAt: { $gt: new Date() },
  });
  const request = requestResult?.value || requestResult;
  if (!request) return false;

  const now = new Date();
  const rewardResult = await db.collection("users").updateOne(
    { _id: request.userId },
    [{
      $set: {
        genesisCrystals: {
          $add: [
            { $ifNull: ["$genesisCrystals", 0] },
            { $ifNull: ["$diamonds", 0] },
            1,
          ],
        },
        diamonds: 0,
        history: {
          $slice: [
            {
              $concatArrays: [
                { $ifNull: ["$history", []] },
                [{
            type: "bump",
            amount: 1,
            desc: "Bumped the Discord server",
            ts: now,
                }],
              ],
            },
            -10,
          ],
        },
      },
    }],
  );
  if (rewardResult.matchedCount !== 1) {
    console.error("[discord bump] pending bumper account was not found:", request.userId);
    return false;
  }

  try {
    await recordBump({
      guildId: request.guildId,
      channelId: request.channelId,
      userId: request.discordId,
      userName: request.userName,
    });
  } catch (error) {
    console.error("[discord bump] reminder scheduling failed:", error.message);
  }

  const channel = await message.channel?.send?.({
    content:
      `<@${request.discordId}> thank you for bumping the server, ` +
      "you have been rewarded 1 Genesis Crystal.",
    allowedMentions: request.discordId
      ? { users: [request.discordId] }
      : { parse: [] },
  });
  return Boolean(channel);
}

export async function startDiscordBumpScheduler(client) {
  discordClient = client;
  try {
    const documents = await getDb()
      .collection(COLLECTION)
      .find({ remindedAt: { $exists: false } })
      .toArray();
    for (const document of documents) scheduleReminder(document);
  } catch (error) {
    console.error("[discord bump] scheduler startup failed:", error.message);
  }
}