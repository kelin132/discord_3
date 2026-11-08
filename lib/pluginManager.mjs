import { findUserByIdentity } from "./identity.mjs";
import { readdirSync, statSync, existsSync } from "fs";
import path from "path";
import { log } from "./logger.mjs";
import { getPermissions } from "./permissions.mjs";
import { commandCooldownMultiplier } from "./membershipBenefits.mjs";
import { canRunOwnerCommand, hasOwnerRole } from "./ownerRoleAccess.mjs";
import { ensureDb } from "./mongo.mjs";
import { getDb } from "./mongo.mjs";
import { discordAccountKey } from "./identity.mjs";
import { resolveDiscordAccount, resolveWhatsAppAccount } from "./accountLink.mjs";
import { isDiscordSupported } from "./discordSupport.mjs";
import { akiraHandler } from "./akiraHandler.mjs";
import { isMediaContent, toDiscordPayload } from "./discordPayload.mjs";
import {
  AIDORU_FOOTER,
  discordAccentColor,
} from "./discordTheme.mjs";
import { invalidateShortRead, shortRead } from "./shortReadCache.mjs";

const PLUGINS_DIR = path.resolve("plugins");
export const SUPPORT_FILE_RE = /^(?:_.*|database|db|parseAmount|balanceFormat|bettingLimits|walletMessage|autoSpawn|pokeautospawn|dbzautospawn|.*Handler)\.js$/i;
let plugins = [];
let commands = [];
const afkUsers = new Map();
const discordCommandCooldowns = new Map();
const pluginByCommand = new Map();

function formatCooldownRemaining(remainingMs) {
  const totalSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s left`;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes}m ${seconds}s left` : `${minutes}m left`;
}

export function getAfkUser(jid) {
  return afkUsers.get(jid) || null;
}

export function setAfkUser(jid, data) {
  invalidateShortRead(jid);
  afkUsers.set(jid, data);
}

export function deleteAfkUser(jid) {
  invalidateShortRead(jid);
  afkUsers.delete(jid);
}

async function getStoredDiscordAfk(jid) {
  return shortRead(jid, async () => {
    try {
      const db = await getDb();
      const user = await db.collection("users").findOne(
        { _id: jid },
        { projection: { afk: 1, name: 1 } },
      );
      if (!user?.afk?.active) return null;
      return {
        reason: user.afk.message || user.afk.reason || "No reason given",
        time: user.afk.since || Date.now(),
        username: user.name || String(jid).split("@")[0].split(":")[0],
      };
    } catch {
      return null;
    }
  });
}

async function clearStoredDiscordAfk(jid) {
  invalidateShortRead(jid);
  try {
    const db = await getDb();
    await db.collection("users").updateOne({ _id: jid }, { $set: { afk: null } });
  } catch {
    // The in-memory status is still cleared when the database is unavailable.
  }
}

function afkElapsed(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"} ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m ago` : `${hours}h ago`;
}

async function sendDiscordAfkEmbed(client, message, {
  rawSender,
  sender,
  title,
  description,
  mentions,
  thumbnail,
}) {
  const channel = await resolveChannel(client, message.channelId, message.channel);
  const prepared = await prepareDiscordPayload({
    discordEmbed: {
      title,
      description,
      color: "#A970FF",
      ...(thumbnail ? { thumbnail } : {}),
    },
    mentions,
  }, rawSender, sender);
  return channel.send(toDiscordPayload(prepared, {
    accentColor: "#A970FF",
    footer: AIDORU_FOOTER,
    embedMedia: true,
  }));
}

async function handleDiscordAfk(client, message, { rawSender, sender, prefix }) {
  if (!message?.channel || !message.author) return;

  const body = String(message.content || "");
  const command = body.startsWith(prefix)
    ? body.slice(prefix.length).trim().split(/\s+/, 1)[0]?.toLowerCase()
    : "";
  const isAfkCommand = command === "afk" || command === "away";

  if (!isAfkCommand) {
    const senderAfk = getAfkUser(sender) || await getStoredDiscordAfk(sender);
    if (senderAfk) {
      deleteAfkUser(sender);
      await clearStoredDiscordAfk(sender);
      const avatarUrl = message.author.displayAvatarURL?.({
        extension: "png",
        size: 128,
        forceStatic: true,
      });
      await sendDiscordAfkEmbed(client, message, {
        rawSender,
        sender,
        title: "👋 Welcome back",
        description: `@${rawSender} is back.\nAway for: ${afkElapsed(Date.now() - senderAfk.time)}.`,
        mentions: [`discord:${rawSender}`],
        thumbnail: avatarUrl,
      }).catch(() => {});
    }
  }

  const mentionedIds = [...(message.mentions?.users?.keys?.() || [])];
  for (const discordId of mentionedIds) {
    const mentionedJid = await resolveDiscordAccount(discordId).catch(() => null)
      || discordAccountKey(discordId);
    const afkData = getAfkUser(mentionedJid) || await getStoredDiscordAfk(mentionedJid);
    if (!afkData) continue;

    const user = message.mentions.users.get(discordId)
      || await client.users.fetch(discordId).catch(() => null);
    const avatarUrl = user?.displayAvatarURL?.({
      extension: "png",
      size: 128,
      forceStatic: true,
    });
    await sendDiscordAfkEmbed(client, message, {
      rawSender,
      sender,
      title: "💤 AFK",
      description:
        `@${discordId} is currently AFK.\n` +
        `Reason : ${afkData.reason}\n` +
        `Since : ${afkElapsed(Date.now() - afkData.time)}`,
      mentions: [`discord:${discordId}`],
      thumbnail: avatarUrl,
    }).catch(() => {});
  }
}

export async function routeMessage() {
  return false;
}

export async function loadPlugins(prefix = ".") {
  plugins = [];
  commands = [];

  if (!existsSync(PLUGINS_DIR)) {
    log("warn", "No plugins/ directory found.");
    return { totalPlugins: 0, totalCommands: 0 };
  }

  const categories = readdirSync(PLUGINS_DIR)
    .filter((entry) => statSync(path.join(PLUGINS_DIR, entry)).isDirectory())
    .sort();

  for (const category of categories) {
    const categoryDir = path.join(PLUGINS_DIR, category);
    const files = readdirSync(categoryDir)
      .filter((file) => file.endsWith(".js"))
      .filter((file) => !SUPPORT_FILE_RE.test(file))
      .sort();

    for (const file of files) {
      try {
        const modulePath = path.join(categoryDir, file);
        const imported = await import(`${modulePath}?v=${Date.now()}`);
        const plugin = imported.default;
        if (!plugin?.name || typeof plugin.run !== "function") {
          log("warn", `Skipping invalid plugin ${category}/${file}`);
          continue;
        }
        if (!isDiscordSupported(plugin)) continue;

        const normalized = {
          ...plugin,
          name: String(plugin.name).toLowerCase(),
          aliases: (plugin.aliases ?? []).map((alias) => String(alias).toLowerCase()),
          category,
          prefix,
        };
        plugins.push(normalized);
      } catch (error) {
        log("warn", `Failed to load plugin ${category}/${file}: ${error.message}`);
      }
    }
  }

  const canonicalOwners = new Map();
  let duplicateCommandCount = 0;
  plugins = plugins.filter((plugin) => {
    if (canonicalOwners.has(plugin.name)) {
      duplicateCommandCount += 1;
      return false;
    }
    canonicalOwners.set(plugin.name, plugin.category);
    return true;
  });
  const canonicalNames = new Set(plugins.map((plugin) => plugin.name));
  const aliasOwners = new Map();
  let duplicateAliasCount = 0;
  plugins = plugins.map((plugin) => ({
    ...plugin,
    aliases: plugin.aliases.filter((alias) => {
      if (canonicalNames.has(alias)) {
        duplicateAliasCount += 1;
        return false;
      }
      if (aliasOwners.has(alias)) {
        duplicateAliasCount += 1;
        return false;
      }
      aliasOwners.set(alias, plugin.name);
      return true;
    }),
  }));
  commands = plugins.flatMap((plugin) => [plugin.name, ...plugin.aliases]);
  pluginByCommand.clear();
  for (const plugin of plugins) {
    if (!pluginByCommand.has(plugin.name)) pluginByCommand.set(plugin.name, plugin);
    for (const alias of plugin.aliases) {
      if (!pluginByCommand.has(alias)) pluginByCommand.set(alias, plugin);
    }
  }

  if (duplicateCommandCount || duplicateAliasCount) {
    log(
      "info",
      `Skipped ${duplicateCommandCount} duplicate command${duplicateCommandCount === 1 ? "" : "s"} and ` +
      `${duplicateAliasCount} duplicate alias${duplicateAliasCount === 1 ? "" : "es"} during startup.`,
    );
  }
  log("info", `Loaded ${plugins.length} plugins from ${categories.length} categories`);
  return { totalPlugins: plugins.length, totalCommands: commands.length };
}

async function resolveChannel(client, id, fallbackChannel) {
  if (!id || id === fallbackChannel?.id) return fallbackChannel;

  const rawId = String(id);
  if (rawId.startsWith("discord:") && rawId.endsWith("@g.us")) {
    return fallbackChannel;
  }
  const discordId = rawId.startsWith("discord:") ? rawId.slice("discord:".length) : rawId;

  try {
    return await client.channels.fetch(discordId);
  } catch {
    try {
      const user = await client.users.fetch(discordId);
      return await user.createDM();
    } catch {
      return fallbackChannel;
    }
  }
}

function discordGroupJid(guildId, channelId = "") {
  return `discord:${guildId}${channelId ? `:${channelId}` : ""}@g.us`;
}

function discordMemberId(value) {
  const raw = String(value || "");
  if (raw.startsWith("discord:")) return raw.slice("discord:".length).split("@")[0];
  return raw.split("@")[0];
}

function discordParticipant(member, guild) {
  const isOwner = member.id === guild.ownerId;
  const isAdmin = isOwner || member.permissions?.has?.("Administrator");
  return {
    id: member.id,
    admin: isOwner ? "superadmin" : isAdmin ? "admin" : undefined,
  };
}

function discordMembers(guild) {
  return [...(guild?.members?.cache?.values?.() || [])];
}

async function discordGroupMetadata(guild, chatId) {
  const members = discordMembers(guild);
  return {
    id: chatId || discordGroupJid(guild.id),
    subject: guild.name,
    desc: guild.description || "",
    owner: guild.ownerId ? `${guild.ownerId}@s.whatsapp.net` : null,
    creation: guild.createdTimestamp ? Math.floor(guild.createdTimestamp / 1000) : null,
    participants: members.map((member) => discordParticipant(member, guild)),
    restrict: false,
    announce: false,
  };
}

function discordGroupSocket(client, message, fallbackChannel) {
  if (!message.guild) return {};

  const guild = message.guild;
  return {
    groupMetadata: async (chatId) => discordGroupMetadata(guild, chatId),
    groupSettingUpdate: async (_chatId, setting) => {
      const isMute = setting === "announcement";
      await fallbackChannel.permissionOverwrites.edit(
        guild.roles.everyone,
        { SendMessages: !isMute },
        { reason: `AKIRA ${isMute ? "mute" : "unmute"} command` },
      );
    },
    groupParticipantsUpdate: async (_chatId, participantIds, action) => {
      if (action !== "remove") {
        throw new Error(`Discord does not support group participant action: ${action}`);
      }

      for (const participantId of participantIds || []) {
        const member = await guild.members.fetch(discordMemberId(participantId));
        await member.kick("AKIRA group moderation command");
      }
      return [];
    },
  };
}

async function compatibilityMessage(message) {
  const isDiscordGroup = Boolean(message.guild);
  const mentionedJid = await Promise.all(
    [...(message.mentions?.users?.keys?.() || [])].map(async (userId) =>
      await resolveDiscordAccount(userId).catch(() => null) || discordAccountKey(userId)
    ),
  );
  let quotedParticipant = null;
  if (message.reference?.messageId && typeof message.fetchReference === "function") {
    const referencedMessage = await message.fetchReference().catch(() => null);
    if (referencedMessage?.author?.id) {
      quotedParticipant =
        await resolveDiscordAccount(referencedMessage.author.id).catch(() => null)
        || discordAccountKey(referencedMessage.author.id);
    }
  }
  const contextInfo = {
    mentionedJid,
    ...(quotedParticipant
      ? { participant: quotedParticipant, quotedParticipant }
      : {}),
  };

  return Object.assign(message, {
    isGroup: isDiscordGroup,
    guildId: message.guildId || message.guild?.id,
    channelId: message.channelId,
    discordChannelId: message.channelId,
    pushName: message.member?.displayName || message.author?.globalName || message.author?.username,
    message: {
      extendedTextMessage: {
        contextInfo,
      },
    },
    key: {
      ...(message.key || {}),
      remoteJid: isDiscordGroup
        ? discordGroupJid(message.guild.id, message.channelId)
        : message.channelId,
      participant: discordAccountKey(message.author?.id),
    },
  });
}

function discordMentionId(value, rawSender, sender) {
  const raw = String(value || "");
  if (
    raw === String(sender || "") ||
    raw === String(rawSender || "") ||
    raw === `discord:${rawSender}`
  ) {
    return String(rawSender || "");
  }
  if (raw.startsWith("discord:")) return raw.slice("discord:".length);
  if (/^\d{5,}$/.test(raw)) return raw;
  return "";
}

async function prepareDiscordPayload(content, rawSender, sender) {
  if (!content || typeof content !== "object") return content;

  const mentions = Array.isArray(content.mentions) ? content.mentions : [];
  const replacements = new Map();
  const normalizedMentions = await Promise.all(mentions.map(async (mention) => {
    let id = discordMentionId(mention, rawSender, sender);
    if (!id) id = await resolveWhatsAppAccount(mention).catch(() => null);
    if (!id) return mention;

    replacements.set(`@${id}`, `<@${id}>`);
    replacements.set(`@discord:${id}`, `<@${id}>`);
    const mentionText = String(mention);
    if (mentionText.includes("@")) {
      replacements.set(`@${mentionText.split("@")[0]}`, `<@${id}>`);
    }
    return `discord:${id}`;
  }));

  if (!replacements.size) return content;

  const replaceMentions = (value) => {
    let output = String(value ?? "");
    for (const [from, to] of [...replacements.entries()].sort(
      ([left], [right]) => right.length - left.length,
    )) {
      output = output.split(from).join(to);
    }
    return output;
  };

  const prepared = { ...content, mentions: normalizedMentions };
  for (const key of ["text", "caption"]) {
    if (typeof prepared[key] === "string") prepared[key] = replaceMentions(prepared[key]);
  }
  if (prepared.discordEmbed && typeof prepared.discordEmbed === "object") {
    prepared.discordEmbed = {
      ...prepared.discordEmbed,
      ...(typeof prepared.discordEmbed.description === "string"
        ? { description: replaceMentions(prepared.discordEmbed.description) }
        : {}),
      ...(Array.isArray(prepared.discordEmbed.fields)
        ? {
            fields: prepared.discordEmbed.fields.map((field) => ({
              ...field,
              ...(typeof field.name === "string" ? { name: replaceMentions(field.name) } : {}),
              ...(typeof field.value === "string" ? { value: replaceMentions(field.value) } : {}),
            })),
          }
        : {}),
    };
  }
  return prepared;
}

export async function routeDiscordMessage(client, message, prefix = ".", ownerId = "") {
  if (!message || message.author?.bot) return;

  const content = String(message.content || "");
  const isPrefixedCommand = content.startsWith(prefix);
  const isSlashStyleCommand = content.startsWith("/");
  if (!isPrefixedCommand && !isSlashStyleCommand) {
    return await akiraHandler({ client, message, prefix });
  }

  const body = content.slice(isSlashStyleCommand ? 1 : prefix.length).trim();
  if (!body) return;

  const [rawCommand, ...rawArgs] = body.split(/\s+/);
  const command = rawCommand.toLowerCase();
  const args = rawArgs;
  const text = rawArgs.join(" ");
  const plugin = pluginByCommand.get(command);
  if (!plugin) return;

  // Ping is a public health check. Do not make it wait for account-link,
  // AFK, or Mongo permission lookups before it can report the gateway state.
  // All other commands continue through the normal authorization path.
  const fastPublicCommand =
    plugin.name === "ping" &&
    !plugin.isOwner &&
    !plugin.isStaff &&
    !plugin.isMod &&
    !plugin.isAdmin &&
    !plugin.isPremium;
  const rawSender = String(message.author.id);
  if (!fastPublicCommand) await ensureDb();
  const linkedAccount = fastPublicCommand
    ? null
    : await resolveDiscordAccount(rawSender).catch(() => null);
  const candidate = linkedAccount || discordAccountKey(rawSender);
  const sender = fastPublicCommand ? candidate : (await findUserByIdentity(candidate))?._id || candidate;
  if (!fastPublicCommand) {
    await handleDiscordAfk(client, message, {
      rawSender,
      sender,
      prefix,
    });
  }

  try {
    const permissions = fastPublicCommand
      ? {
          isOwner: false,
          isStaff: false,
          isMod: false,
          isPremium: false,
          isJailed: false,
          isBanned: false,
          membershipTier: "none",
        }
      : await (async () => {
          await ensureDb();
          return getPermissions(sender, ownerId, {
            discordId: rawSender,
            linkedAccount: Boolean(linkedAccount),
            linkedWhatsappId: linkedAccount,
          });
        })();
    const {
      isOwner,
      isStaff,
      isMod,
      isPremium,
      isJailed,
      isBanned,
      membershipTier = "none",
      staffLevel = 0,
    } = permissions;
    const isOwnerRole = hasOwnerRole(isOwner, staffLevel);

    if (isBanned && !isOwner) {
      await message.reply("🚫 You are banned from using this bot.");
      return;
    }
    if (isJailed && plugin?.name !== "escape") {
      await message.reply("🔒 You are jailed. Use `.escape` with a Getaway Tool or wait for the timer to end.");
      return;
    }

    if (!canRunOwnerCommand(plugin, isOwner, staffLevel)) {
      await message.reply("❌ Owner only command.");
      return;
    }
    if (plugin.isStaff && !isStaff && !isOwner) {
      await message.reply("❌ Staff only command.");
      return;
    }
    const discordServerAdmin =
      message.guild &&
      plugin.discordAdmin &&
      (message.member?.permissions?.has?.("ManageGuild") ||
        message.member?.permissions?.has?.("Administrator"));
    if (plugin.isMod && !isMod && !isOwner && !discordServerAdmin) {
      await message.reply("❌ Moderator only command.");
      return;
    }
    if (
      plugin.isAdmin &&
      !isOwner &&
      !message.member?.permissions?.has?.("ManageGuild") &&
      !message.member?.permissions?.has?.("Administrator")
    ) {
      await message.reply("❌ Server administrators only.");
      return;
    }

    const cooldownSeconds = Number(plugin.cooldown);
    if (Number.isFinite(cooldownSeconds) && cooldownSeconds > 0) {
      const cooldownMs = cooldownSeconds * 1000 * commandCooldownMultiplier(membershipTier);
      const cooldownKey = `${sender}:${plugin.name}`;
      const lastUsed = discordCommandCooldowns.get(cooldownKey) || 0;
      const remainingMs = cooldownMs - (Date.now() - lastUsed);

      if (remainingMs > 0) {
        const cooldownPayload = toDiscordPayload({
          discordEmbed: {
            title: `⏳ .${plugin.name} Cooldown`,
            description: `**${formatCooldownRemaining(remainingMs)}**`,
            color: "#FF5D73",
            footer: { text: "Try again when the cooldown expires." },
          },
        }, {
          accentColor: "#FF5D73",
          title: plugin.discordTitle || `.${plugin.name}`,
          command: plugin.name,
          thumbnail: message.author?.displayAvatarURL?.({
            extension: "png",
            size: 128,
            forceStatic: true,
          }),
          embedMedia: true,
        });
        await message.reply(cooldownPayload);
        return;
      }

      discordCommandCooldowns.set(cooldownKey, Date.now());
    }

    const mockSock = {
      sendMessage: async (id, content, options = {}) => {
        const channel = await resolveChannel(client, id, message.channel);
        const discordContent = await prepareDiscordPayload(content, rawSender, sender);
        if (content?.react?.text) {
          if (options.quoted?.react) {
            return options.quoted.react(content.react.text);
          }
          return null;
        }
        if (
          plugin.discordPlainText
          && discordContent
          && typeof discordContent === "object"
          && typeof discordContent.text === "string"
          && !isMediaContent(discordContent)
        ) {
          return channel.send({ content: discordContent.text });
        }
        const payload = toDiscordPayload(discordContent, {
          accentColor: discordAccentColor(plugin),
          title: plugin.discordTitle,
          command: plugin.name,
          footer: AIDORU_FOOTER,
          thumbnail: message.author?.displayAvatarURL?.({
            extension: "png",
            size: 128,
            forceStatic: true,
          }),
          embedMedia: true,
        });
        if (options.quoted && typeof options.quoted.reply === "function") {
          return options.quoted.reply(payload);
        }
        return channel.send(payload);
      },
      sendPresenceUpdate: async () => undefined,
      profilePictureUrl: async (id) => {
        const userId = String(id || "").replace(/^discord:/, "").split("@")[0];
        const user = await client.users.fetch(userId);
        return user.displayAvatarURL({ extension: "png", size: 256, forceStatic: true });
      },
      onWhatsApp: async (id) => [{ jid: String(id || ""), exists: true }],
      contacts: Object.create(null),
      user: client.user,
      ...discordGroupSocket(client, message, message.channel),
    };

    const commandSock = mockSock;

    await plugin.run({
      sock: commandSock,
      msg: await compatibilityMessage(message),
      args,
      text,
      cmd: command,
      sender,
      rawSender,
      prefix,
      isOwner: isOwnerRole,
      isActualOwner: isOwner,
      isStaff,
      isMod,
      isPremium,
      isJailed,
      staffLevel,
      senderNum: rawSender,
      discord: { client, message },
    });
  } catch (error) {
    log("error", `Command ${command} failed: ${error.stack || error.message}`);
    try {
      const detail = String(error?.message || "Unknown error")
        .replace(/mongodb(?:\+srv)?:\/\/\S+/gi, "database connection")
        .replace(/\s+/g, " ")
        .slice(0, 180);
      await message.reply(`❌ \`${command}\` failed: ${detail}`);
    } catch {
      // The channel may have disappeared; the original error is already logged.
    }
  }
}

export async function routeDiscordInteraction(client, interaction, prefix = ".", ownerId = "") {
  if (!interaction?.isButton?.() && !interaction?.isAnySelectMenu?.()) return;

  for (const plugin of plugins) {
    const handlesCustomId =
      typeof plugin.onDiscordInteraction === "function" &&
      String(interaction.customId || "").startsWith(`${plugin.name}:`);

    const handlesGeneralInteraction = typeof plugin.onInteraction === "function";

    if (handlesCustomId || handlesGeneralInteraction) {
      try {
        if (handlesCustomId) {
          await plugin.onDiscordInteraction({ client, interaction, prefix, ownerId });
        }
        if (handlesGeneralInteraction) {
          await plugin.onInteraction({ interaction, client, prefix, ownerId });
        }
      } catch (error) {
        log("error", `Discord interaction failed for plugin ${plugin.name}: ${error.stack || error.message}`);
        const errorContent = "❌ That control could not be used.";
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({ content: errorContent }).catch(() => {});
        } else {
          await interaction.reply({ content: errorContent, ephemeral: true }).catch(() => {});
        }
      }
    }
  }
}

export function getPlugins() {
  return plugins;
}

export function getCommands() {
  return commands;
}
