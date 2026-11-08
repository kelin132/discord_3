import { getUser, requireRegistration } from "./database.js";
import { generateProfileImage, getProfilePic, resolveRole } from "../../lib/profileGen.mjs";
import { generateAnimatedProfileCard } from "../../lib/profileAnimation.mjs";
import { resolveProfileVideoSource } from "../../lib/profileMedia.mjs";
import { getLevelRole, getAllEarnedRoles, getLevelRoleLabel } from "../../lib/levelRoles.mjs";
import { getUser as getCardUser } from "../cards/db.js";
import { countTrainerPokemon } from "../../lib/pokemon/pokemonDb.mjs";
import { guildSystem } from "../../lib/guildSystem.js";
import { GYMS } from "../../lib/pokemon/gymData.mjs";
import { getTrainer } from "../../lib/pokemon/players.mjs";

const xpForLevel = (level) => level * 100;
function isProfileMediaUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

function isProfileImage(value) {
  return isProfileMediaUrl(value) ||
    (typeof value === "string" && /^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(value));
}

function withTimeout(promise, timeoutMs, fallback = null) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function sendProfileFallback({ sock, jid, msg, caption, profilePic, target }) {
  if (profilePic) {
    try {
      await sock.sendMessage(
        jid,
        { image: { url: profilePic }, caption },
        { quoted: msg }
      );
      return;
    } catch (fallbackError) {
      console.error(
        "[profile] Avatar fallback delivery failed:",
        fallbackError.stack || fallbackError.message || fallbackError
      );
    }
  }

  await sock.sendMessage(
    jid,
    { text: caption, mentions: [target] },
    { quoted: msg }
  );
}

function fmtDate(iso) {
  if (!iso) return "Unknown";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short", day: "numeric", year: "numeric",
    });
  } catch { return "Unknown"; }
}

function gymAchievementSummary(trainer) {
  const badges = Array.isArray(trainer?.badges) ? trainer.badges.map(String) : [];
  const rewards = trainer?.gymRewards && typeof trainer.gymRewards === "object"
    ? Object.keys(trainer.gymRewards)
    : [];
  const earnedIds = new Set(
    [...badges, ...rewards]
      .map((value) => value.trim().toLowerCase().replace(/-badge$/i, ""))
      .filter(Boolean),
  );
  const earnedGyms = GYMS.filter((gym) => earnedIds.has(gym.id));
  const explicitWins = [trainer?.gymWins, trainer?.gymBattleWins, trainer?.gymVictories]
    .map(Number)
    .find((value) => Number.isFinite(value) && value >= 0);
  const wins = explicitWins ?? earnedGyms.length;
  const nextGym = GYMS.find((gym) => !earnedGyms.some((earned) => earned.id === gym.id));

  return {
    wins,
    completed: earnedGyms.length,
    total: GYMS.length,
    badges: earnedGyms.length ? earnedGyms.map((gym) => gym.badge).join(", ") : "None yet",
    next: nextGym ? nextGym.name : "Circuit complete",
  };
}

export default {
  name: "profile",
  description: "View your economy profile card",
  category: "economy",
  usage: ".profile [@user]",
  aliases: ["me", "acc", "account", "p"],
  cooldown: 5,

  async run({ sock, msg, sender, cmd, isOwner, isMod, isStaff, discord }) {
    const jid = msg.key.remoteJid;

    // Check for @mention or tagged quoted message participant
    const contextInfo = msg.message?.extendedTextMessage?.contextInfo 
      || msg.message?.imageMessage?.contextInfo 
      || msg.message?.videoMessage?.contextInfo;
      
    const mentioned  = contextInfo?.mentionedJid?.[0];
    const quotedUser = contextInfo?.participant;

    const target = mentioned || quotedUser || sender;

    if (target === sender && !await requireRegistration(sock, msg, sender)) return;

    // `.p` is the fast self-profile shortcut. The generated image does not
    // use card/Pokémon/trainer details, so avoid those extra database reads.
    const isQuickProfile = cmd === "p" && target === sender;
    const mentionedDiscordUser = discord?.message?.mentions?.users?.first?.();
    const discordProfileUser = mentionedDiscordUser || discord?.message?.author;
    const discordAvatarHash = String(discordProfileUser?.avatar || "");
    const hasAnimatedDiscordAvatar = discordAvatarHash.startsWith("a_");
    const discordAvatar = discordProfileUser?.displayAvatarURL?.({
      extension: hasAnimatedDiscordAvatar ? "gif" : "png",
      size: 512,
      forceStatic: false,
    }) || null;

    // Keep every independent lookup in one batch so another user's profile
    // does not wait for the cards query before starting the other reads.
    const [cardUser, user, profilePicFromSocket, pokemonCount, guild, trainer] = await Promise.all([
      getCardUser(target),
      getUser(target),
      withTimeout(getProfilePic(sock, target, discordAvatar), 2500),
      countTrainerPokemon(target),
      withTimeout(guildSystem.getUserPrimaryGuild(target), 2500),
      isQuickProfile ? Promise.resolve(null) : withTimeout(getTrainer(target), 2500),
    ]);
    const hasWebsiteProfile = Boolean(user?.websiteProfileUpdatedAt);
    const websiteAvatarCandidates = [
      user?.profilePictureUrl,
      user?.profileImage,
      user?.avatarUrl,
      cardUser?.profilePictureUrl,
      cardUser?.profileImage,
      cardUser?.avatarUrl,
    ];
    const websiteAvatar = (hasWebsiteProfile
      ? websiteAvatarCandidates.slice(0, 3)
      : websiteAvatarCandidates
    ).find(isProfileImage);
    const profilePic = websiteAvatar || profilePicFromSocket;
    const profileVideo = resolveProfileVideoSource({
      user,
      cardUser,
      fallback: hasAnimatedDiscordAvatar ? discordAvatar : null,
    });

    const tag   = target.split("@")[0].split(":")[0];
    const level = user.level ?? 1;
    const xp    = user.xp    ?? 0;
    const registeredName = String(user.name || "User").trim() || "User";
    const cardsOwned = Array.isArray(cardUser?.cards)
      ? cardUser.cards.length
      : (cardUser?.totalCards ?? 0);
    const history = Array.isArray(user.history) ? user.history : [];
    const gameTypes = new Set(["bet", "coinflip", "slots", "roulette", "scratch", "gamble"]);
    const casinoTypes = new Set(["slots", "roulette", "scratch", "gamble"]);
    const gamesPlayed = history.filter((entry) => gameTypes.has(entry.type)).length;
    const casinoGames = history.filter((entry) => casinoTypes.has(entry.type)).length;

    const role = resolveRole({
      isOwner:    target === sender ? isOwner  : false,
      isMod:      target === sender ? isMod    : (user.staffLevel >= 1),
      isStaff:    target === sender ? isStaff  : (user.staffLevel >= 2),
      isPremium:  user.isPremium,
      staffLevel: user.staffLevel ?? 0,
    });

    const levelRole   = getLevelRole(level);
    const earnedRoles = getAllEarnedRoles(level);
    const roleLabel   = getLevelRoleLabel(level);
    const guildName   = String(guild?.name || user.guildName || user.guild || "None").trim() || "None";
    const joinedDate  = fmtDate(user.registeredAt);
    const roleShort = {
      Owner: "OWNER",
      Moderator: "MOD",
      Staff: "STAFF",
      Premium: "PREMIUM",
      Member: "MEMBER",
    }[role] || role.toUpperCase();
    const gymProgress = gymAchievementSummary(trainer);

    const lastDaily       = user.lastDaily ?? 0;
    const hoursSinceDaily = (Date.now() - lastDaily) / 36e5;
    const streak          = hoursSinceDaily < 48 ? (user.streak ?? 1) : 0;

    const daysActive = user.registeredAt
      ? Math.max(0, Math.floor((Date.now() - new Date(user.registeredAt).getTime()) / 86400000))
      : 0;

    const reach = Number.isFinite(Number(user.reach)) ? Number(user.reach) : daysActive;
    const displayName = registeredName;
    const profileAge = user.age === null || user.age === undefined || user.age === "" ? "N/A" : user.age;
    const profileBirthday = String(user.birthday || "N/A").trim() || "N/A";
    const profileBio = String(user.bio || "N/A").trim() || "N/A";
    const profileCards = Number.isFinite(Number(cardsOwned))
      ? Number(cardsOwned).toLocaleString()
      : "N/A";
    const profilePokemon = Number.isFinite(Number(pokemonCount))
      ? Number(pokemonCount).toLocaleString()
      : "N/A";
    const profileBadges = isQuickProfile
      ? "—"
      : Number.isFinite(Number(gymProgress.completed)) ? gymProgress.completed : "N/A";
    const caption =
`╭━━━〔 🌸 𝗣𝗥𝗢𝗙𝗜𝗟𝗘 〕━━━╮
│ ❀ Name : \`${displayName}\`
│ ❀ Age : \`${profileAge}\`
│ ❀ Bday : \`${profileBirthday}\`
│ ❀ Bio : \`${profileBio}\`
│ ❀ Cards : \`${profileCards}\`
│ ❀ Pokémon : \`${profilePokemon}\`
│ ❀ Badges : \`${profileBadges}\`
│ ❀ Role : \`${role}\`
│
│  *view and edit your profile image*
│ *here:*
│  *https://aidoru.zone.id/profile*
╰━━━━━━━━━━━━━━━━━━━━━━╯`;

    const profileCardData = {
      username:     registeredName,
      tag,
      role,
      level,
      xp,
      xpTarget:     xpForLevel(level),
      reach,
      wallet:       user.money    ?? 0,
      bank:         user.bank     ?? 0,
      bio:          user.bio      || "No bio set.",
      guild:        guildName,
      joined:       joinedDate,
      streak,
      items:        user.inventory?.length ?? 0,
      transactions: user.history?.length   ?? 0,
      profileImage: profilePic,
      profileBackground: user.profileBackground || null,
      profileFrame: user.profileFrame || null,
      levelRole,
      earnedRoles,
      daysActive,
      cards: cardsOwned,
      games: gamesPlayed,
      pokemon: pokemonCount,
      diamonds: user.genesisCrystals ?? 0,
      genesisCrystals: user.genesisCrystals ?? 0,
    };

    if (profileVideo) {
      try {
        const video = await generateAnimatedProfileCard(profileCardData, profileVideo);
        await sock.sendMessage(
          jid,
          {
            video,
            mimetype: "video/mp4",
            fileName: "profile.mp4",
            gifPlayback: true,
            caption,
          },
          { quoted: msg },
        );
        return;
      } catch (err) {
        console.error(
          "[profile] Animated profile-card rendering failed; sending the standard profile card:",
          err.stack || err.message || err,
        );
      }
    }

    let imgBuffer;
    try {
      imgBuffer = await generateProfileImage(profileCardData);

    } catch (err) {
      console.error(
        "[profile] Canvas generation failed:",
        err.stack || err.message || err
      );
      await sendProfileFallback({ sock, jid, msg, caption, profilePic, target });
      return;
    }

    try {
      if (discord?.message) {
        await sock.sendMessage(jid, {
          image: imgBuffer,
          fileName: "profile.png",
          discordEmbed: {
            title: `🌸 ${displayName}'s Profile`,
            description: `${roleShort} • Level ${level} • ${roleLabel}\n${guildName}\nCards: ${profileCards} • Pokémon: ${profilePokemon}`,
            color: "#9B87F5",
            thumbnail: discordAvatar,
            fields: [
              { name: "Name", value: displayName, inline: true },
              { name: "Age", value: String(profileAge), inline: true },
              { name: "Role", value: role, inline: true },
              { name: "Bio", value: profileBio.slice(0, 1024), inline: false },
              { name: "Wallet", value: `$${Number(user.money ?? 0).toLocaleString()}`, inline: true },
              { name: "Bank", value: `$${Number(user.bank ?? 0).toLocaleString()}`, inline: true },
              { name: "XP", value: `${Number(xp).toLocaleString()} / ${Number(xpForLevel(level)).toLocaleString()}`, inline: true },
              { name: "Cards", value: profileCards, inline: true },
              { name: "Pokémon", value: profilePokemon, inline: true },
              { name: "Badges", value: `${profileBadges}/${gymProgress.total}`, inline: true },
              { name: "Streak", value: `${streak} day${streak === 1 ? "" : "s"}`, inline: true },
            ],
            image: "attachment",
            footer: { text: "✦ AIDORU • AKIRA" },
          },
        }, { quoted: msg });
        return;
      }

      await sock.sendMessage(jid, { image: imgBuffer, caption }, { quoted: msg });
    } catch (err) {
      console.error(
        "[profile] Canvas image delivery failed:",
        err.stack || err.message || err
      );
      await sendProfileFallback({ sock, jid, msg, caption, profilePic, target });
    }
  },
};
