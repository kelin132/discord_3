/**
 * KELIN MD — Card API helper
 * Fetches the shared AIDORU card catalog and caches it for 1 hour.
 *
 * Supports the same classic and letter tiers used by the WhatsApp bot.
 */

import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { getSeriesCached, prefetchSeries } from "./seriesEnrich.mjs";
import { getCardClaimId } from "./cardClaimId.mjs";

const API_ORIGIN = "https://cardapi.eulaorg.app";
const API_BASE = `${API_ORIGIN}/api/download`;
const API_RANDOM_BASE = `${API_ORIGIN}/api/random`;
const LEGACY_API_HOST = "eula-cardapi.suhotech.xyz";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const API_FETCH_TIMEOUT_MS = 45_000;  // The shared catalog is a larger download.
const RANDOM_FETCH_TIMEOUT_MS = 15_000;
const RANDOM_EVENT_RETRIES = 3;
const MEDIA_FETCH_TIMEOUT_MS = 30_000; // 30 seconds for downloading card images
const execFileAsync = promisify(execFile);
const MEDIA_CACHE_DIR = join(tmpdir(), "kelin-md-card-media");
const MEDIA_CACHE_VERSION = "v2-faststart";
const CARD_VIDEO_CACHE = new Map();

mkdirSync(MEDIA_CACHE_DIR, { recursive: true });

// ── Tier mappings ─────────────────────────────────────────────────────────────

export const TIER_NAME = {
  "1": "Common",
  "2": "Uncommon",
  "3": "Rare",
  "4": "Epic",
  "5": "Legendary",
  "6": "Mythical",
  "S": "Secret",
  C: "C",
  R: "R",
  SR: "SR",
  SSR: "SSR",
  UR: "UR",
  X: "X",
};

export const TIER_NUM = {
  "common":    "1",
  "uncommon":  "2",
  "rare":      "3",
  "epic":      "4",
  "legendary": "5",
  "mythical":  "6",
  "secret":    "S",
  "s":         "S",
  "tier s":    "S",
  "c": "C", "tier c": "C",
  "r": "R", "tier r": "R",
  "sr": "SR", "tier sr": "SR",
  "ssr": "SSR", "tier ssr": "SSR",
  "ur": "UR", "tier ur": "UR",
  "x": "X", "tier x": "X",
  "1": "1", "2": "2", "3": "3", "4": "4", "5": "5", "6": "6",
  "S": "S", "C": "C", "R": "R", "SR": "SR", "SSR": "SSR", "UR": "UR", "X": "X",
};

export const TIER_EMOJI = {
  Common: "⚪", Uncommon: "🟢", Rare: "🔵", Epic: "🟣", Legendary: "🟡", Mythical: "🔴", Secret: "🌟",
  C: "💠", R: "🔷", SR: "🟣", SSR: "💎", UR: "🌠", X: "✨",
};

export const TIER_PRICE = {
  Common:    [1_000, 10_000],
  Uncommon:  [10_000, 30_000],
  Rare:      [30_000, 60_000],
  Epic:      [60_000, 80_000],
  Legendary: [80_000, 100_000],
  Mythical:  [100_000, 300_000],
  Secret:    [300_000, 600_000],
  C:         [600_000, 800_000],
  R:         [800_000, 1_000_000],
  SR:        [1_000_000, 5_000_000],
  SSR:       [5_000_000, 10_000_000],
  UR:        [10_000_000, 20_000_000],
  X:         [20_000_000, 50_000_000],
};

export function createSpawnId() {
  return Math.random().toString(16).slice(2, 7).padEnd(5, "0");
}

/** Build the shared caption used by manual and automatic card spawns. */
export function buildCardSpawnCaption(card, spawnId, prefix = ".") {
  const claimId = getCardClaimId(card);
  return `╭─❀「 🃏 *𝐂𝐀𝐑𝐃 𝐒𝐏𝐀𝐖𝐍* 」❀─╮
│ 🃏 *Name*   :: *${card.name}*
│ ⭐ *Tier*   :: *${card.tier}*
│ 📺 *Series* :: *${card.series}*
│ 💰 *Value*  :: $${Number(card.price || 0).toLocaleString("en-US")}
│ 🆔 *Claim #* :: \`${claimId}\`
│ 🔹 *Spawn*  :: \`${spawnId}\`
│
│ 💬 Type *${prefix}claim ${claimId}* to grab it!
│ ⚡ First come, first served~
╰───────────────❀`;
}

/** Build the Discord embed used by automatic card spawns. */
export async function buildDiscordCardSpawnPayload(card, spawnId, prefix = ".") {
  const claimId = getCardClaimId(card);
  const embed = {
    title: "🃏 𝐂𝐀𝐑𝐃 𝐒𝐏𝐀𝐖𝐍",
    description: "A new collectible card has appeared in AIDORU!",
    color: 0x31C8FF,
    fields: [
      { name: "🃏 Name", value: String(card.name || "Unknown"), inline: false },
      { name: "⭐ Tier", value: String(card.tier || "Common"), inline: true },
      { name: "📺 Series", value: String(card.series || "Unknown"), inline: true },
      { name: "💰 Claim cost", value: `$${Number(card.price || 0).toLocaleString("en-US")}`, inline: true },
      { name: "🔢 Claim #", value: `\`${claimId}\``, inline: true },
      { name: "🔹 Spawn ID", value: `\`${spawnId}\``, inline: true },
    ],
    footer: {
      text: `Use ${prefix}claim ${claimId} • First come, first served`,
    },
  };
  const payload = { embeds: [embed] };

  if (card.media) {
    const url = await resolveMediaUrl(card.media);
    const extension = card.mediaType === "gif" || card.tierNum === "6" || card.tierNum === "S"
      ? "gif"
      : "jpg";
    embed.image = { url: `attachment://card.${extension}` };
    payload.files = [{ attachment: url, name: `card.${extension}` }];
  }

  return payload;
}

// Weighted spawn probability (higher weight = more common)
export const TIER_WEIGHTS = [
  { num: "1", weight: 38 },
  { num: "2", weight: 24 },
  { num: "3", weight: 17 },
  { num: "4", weight: 10 },
  { num: "5", weight:  6 },
  { num: "6", weight:  4 },
  { num: "S", weight:  1 },
  { num: "C", weight: 5 },
  { num: "R", weight: 5 },
  { num: "SR", weight: 4 },
  { num: "SSR", weight: 3 },
  { num: "UR", weight: 2 },
  { num: "X", weight: 1.5 },
];
export function pickRandomTier(random = Math.random, availableTiers = TIER_WEIGHTS) {
  const totalWeight = availableTiers.reduce((sum, tier) => sum + tier.weight, 0);
  if (!availableTiers.length || totalWeight <= 0) return TIER_WEIGHTS.at(-1)?.num || "1";

  let roll = random() * totalWeight;
  for (const { num, weight } of availableTiers) {
    roll -= weight;
    if (roll <= 0) return num;
  }
  return availableTiers.at(-1)?.num || "1";
}

// ── In-memory cache ───────────────────────────────────────────────────────────

/** @type {{ cards: object[], fetchedAt: number } | null} */
let _cache = null;

/**
 * Return all cards across all tiers, using cache if still fresh.
 * Throws a descriptive CARD_API_DOWN error when the external API is unreachable,
 * so callers can surface a clear message to users instead of a generic failure.
 * @returns {Promise<object[]>}
 */
export async function fetchAllCards() {
  const now = Date.now();
  if (_cache && now - _cache.fetchedAt < CACHE_TTL_MS) {
    return _cache.cards;
  }

  let cards;
  try {
    const response = await fetch(API_BASE, {
      signal: AbortSignal.timeout(API_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Card API HTTP ${response.status}`);
    const payload = await response.json();
    const sourceCards = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.results)
        ? payload.results
        : Array.isArray(payload?.data)
          ? payload.data
          : null;
    if (!sourceCards) throw new Error("Unexpected card catalog response");
    cards = sourceCards
      .filter((raw) => !String(raw?.event || "").trim())
      .map((raw, index) => normalise(raw, index + 1));
  } catch (error) {
    const err = new Error(
      `Card API is currently unreachable — please try again later. (${error?.message ?? "request failed"})`,
    );
    err.code = "CARD_API_DOWN";
    throw err;
  }
  if (!cards.length) {
    const err = new Error("The card catalog currently has no cards available.");
    err.code = "CARD_API_DOWN";
    throw err;
  }

  _cache = { cards, fetchedAt: Date.now() };

  // Background-enrich series names for cards that are still "Unknown".
  // This runs async without blocking the caller — subsequent fetches
  // from cache will have the enriched series populated by then.
  const unenriched = cards.filter(c => c.series === "Unknown").map(c => c.name);
  if (unenriched.length > 0) prefetchSeries(unenriched);

  return cards;
}

/** Force-clear the cache (useful for testing). */
export function clearCache() {
  _cache = null;
}

export function normalizeCardMediaUrl(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    if (url.hostname === LEGACY_API_HOST) url.hostname = new URL(API_ORIGIN).hostname;
    return url.toString();
  } catch {
    return value;
  }
}

// ── Redirect resolver ─────────────────────────────────────────────────────────

/** Map<originalUrl, resolvedUrl> — persists for the process lifetime */
const _urlCache = new Map();

/**
 * Resolve a URL to its final destination, following any 301/302 redirects.
 * Results are cached so each URL is only resolved once.
 * @param {string} url
 * @returns {Promise<string>} Final URL (or original if resolution fails)
 */
export async function resolveMediaUrl(url) {
  if (!url) return url;
  if (!url.includes("asapi.shoob.gg")) return url; // already a direct CDN link
  if (_urlCache.has(url)) return _urlCache.get(url);

  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    const location = res.headers.get("location");
    const resolved = location || url;
    _urlCache.set(url, resolved);
    return resolved;
  } catch {
    return url; // fall back to original on error
  }
}

// ── Card normalisation ────────────────────────────────────────────────────────

/**
 * Normalise a raw API card into a consistent internal shape.
 * Uses the in-memory series cache when available (populated by prefetchSeries).
 */
export function normalise(raw, index = 0) {
  const tierNum = String(raw?.tier ?? raw?.tierNum ?? "").trim().toUpperCase();
  const tierName = TIER_NAME[tierNum] || `Tier ${tierNum || "?"}`;
  const [min, max] = TIER_PRICE[tierName] || [100, 500];
  const sourcePrice = Number(raw?.value);
  const price = raw?.value_currency === "coins" && Number.isFinite(sourcePrice) && sourcePrice > 0
    ? Math.round(sourcePrice)
    : Math.floor(Math.random() * (max - min)) + min;

  // Check series enrichment cache (populated async after first full fetch)
  const name = String(raw?.title || raw?.name || "Unknown");
  const cardId = String(raw?.id || makeId(name, tierNum)).toUpperCase();
  const cachedSeries = getSeriesCached(name);
  const declaredMediaType = String(raw?.media_type || "").trim().toLowerCase();
  const sourceMediaType = String(raw?.source_media_type || "").trim().toLowerCase();
  const rawMediaUrl = String(raw?.gifUrl || raw?.image || raw?.url || raw?.imageUrl || raw?.source_image || "");
  const mediaType = [
    declaredMediaType,
    sourceMediaType,
    raw?.mime_type,
    raw?.mediaType,
  ].some((value) => /gif|video|animated/i.test(String(value || "")))
    || raw?.is_animated === true
    || Boolean(raw?.gifUrl)
    || /\.gif(?:$|[?#])/i.test(rawMediaUrl)
    || tierNum === "6"
    || tierNum === "S"
    ? "gif"
    : "image";
  const media = normalizeCardMediaUrl(
    (mediaType === "gif" && raw?.gifUrl)
      || raw?.image
      || raw?.url
      || raw?.imageUrl
      || raw?.source_image
      || raw?.gifUrl
      || null,
  );
  const mediaFallbacks = [...new Set([
    ...(Array.isArray(raw?.image_fallbacks) ? raw.image_fallbacks : []),
    raw?.image_preview,
    raw?.thumbnailUrl,
    raw?.thumbnail,
    raw?.source_image,
    raw?.imageUrl,
    raw?.url,
  ].map(normalizeCardMediaUrl).filter((url) => url && url !== media))];

  return {
    cardId,
    claimId: getCardClaimId({ name, tierNum }),
    name,
    tier:      tierName,
    tierNum,
    series:    raw?.series || cachedSeries || "Unknown",
    index,
    media,
    mediaFallbacks,
    thumbnail: raw?.thumbnailUrl || raw?.thumbnail || null,
    mediaType,
    price,
  };
}

/**
 * Generate a stable card ID from its title and tier.
 * e.g. "Zero Two and Hiro", "5" → "5_ZERO_TWO_AND_HIRO"
 */
function makeId(title, tierNum) {
  // Deterministic 5-digit number (10000–99999) from title + tier hash
  let hash = 0;
  const str = `${tierNum}:${title.toUpperCase()}`;
  for (const ch of str) hash = (hash * 31 + ch.charCodeAt(0)) & 0x7fffffff;
  return String(10000 + (hash % 90000));
}

// ── Query helpers ─────────────────────────────────────────────────────────────

/**
 * Pick a random card using weighted tier probability.
 * @returns {Promise<object>}
 */
export async function pickRandomCard() {
  return fetchRandomCard();
}

function normalizeTierInput(tier) {
  const value = String(tier ?? "").trim();
  const key = value.toLowerCase();
  return TIER_NUM[key] || TIER_NUM[key.replace(/^tier\s+/, "")] || value.toUpperCase();
}

export async function fetchRandomCard(tier) {
  const tierNum = tier == null || String(tier).trim() === ""
    ? pickRandomTier()
    : normalizeTierInput(tier);
  if (!TIER_NAME[tierNum]) {
    const error = new Error(`Unknown card tier: ${tier}`);
    error.code = "CARD_API_DOWN";
    throw error;
  }

  try {
    const url = `${API_RANDOM_BASE}?tier=${encodeURIComponent(tierNum)}`;
    for (let attempt = 0; attempt <= RANDOM_EVENT_RETRIES; attempt += 1) {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(RANDOM_FETCH_TIMEOUT_MS),
      });
      const payload = await response.json();
      if (!response.ok || payload?.success === false) {
        throw new Error(payload?.error || `Card API HTTP ${response.status}`);
      }

      const raw = payload?.card || payload?.result || payload?.data || payload;
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.success === false) {
        throw new Error("Unexpected random-card response");
      }
      if (String(raw.event ?? "").trim()) continue;

      const claimId = raw.claimId ?? raw.index ?? raw.id ?? raw.cardId ?? 1;
      return normalise(raw, claimId);
    }

    const cards = await fetchAllCards();
    const pool = cards.filter((card) => card.tierNum === tierNum);
    if (!pool.length) throw new Error(`No non-event cards found for tier ${tierNum}`);
    return pool[Math.floor(Math.random() * pool.length)];
  } catch (error) {
    const apiError = new Error(
      `Card API is currently unreachable — please try again later. (${error?.message ?? "request failed"})`,
    );
    apiError.code = "CARD_API_DOWN";
    throw apiError;
  }
}

/**
 * Search cards by name (case-insensitive substring).
 * @param {string} query
 * @param {number} [limit=10]
 * @returns {Promise<object[]>}
 */
export async function searchCards(query, limit = 10) {
  const all = await fetchAllCards();
  const re  = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  return all.filter(c => re.test(c.name)).slice(0, limit);
}

/**
 * Find a single card by exact ID or closest name match.
 * @param {string} query  cardId or partial name
 * @returns {Promise<object | null>}
 */
export async function getCard(query) {
  const all = await fetchAllCards();
  const byClaimId = all.find(c => getCardClaimId(c) === query.trim().toUpperCase());
  if (byClaimId) return byClaimId;
  // Exact ID
  const byId = all.find(c => c.cardId === query.toUpperCase());
  if (byId) return byId;
  // Exact name (case-insensitive)
  const byName = all.find(c => c.name.toLowerCase() === query.toLowerCase());
  if (byName) return byName;
  // Partial name
  const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  return all.find(c => re.test(c.name)) || null;
}

/**
 * Return all cards of a given tier (by number string "1"–"5" or name).
 * @param {string} tier   "1"–"5" or "Common" etc.
 * @returns {Promise<object[]>}
 */
export async function getCardsByTier(tier) {
  const all    = await fetchAllCards();
  const num    = TIER_NUM[tier.toLowerCase()] || TIER_NUM[tier] || tier;
  return all.filter(c => c.tierNum === num);
}

/**
 * Return a count summary by tier without a full fetch (uses cache if warm,
 * otherwise fetches). Shape: { Common: N, Uncommon: N, ... }
 */
export async function getTierCounts() {
  const all = await fetchAllCards();
  const out = Object.fromEntries(Object.values(TIER_NAME).map((name) => [name, 0]));
  for (const c of all) {
    if (out[c.tier] !== undefined) out[c.tier]++;
  }
  return out;
}

/**
 * Fetch a single card from a specific tier directly from the API (bypasses cache).
 * Useful for quiz/spawn where you need a fresh random card of a given tier.
 * @param {string} tier  "1"–"6" or "S"
 * @returns {Promise<object|null>}
 */
export async function fetchCardByTier(tier) {
  const num = TIER_NUM[String(tier).toLowerCase()] ?? String(tier).toUpperCase();
  try {
    const cards = await getCardsByTier(num);
    if (!cards.length) return null;
    return cards[Math.floor(Math.random() * cards.length)];
  } catch (e) {
    console.error(`[cardApi] fetchCardByTier(${tier}) error:`, e.message);
    return null;
  }
}

function cardVideoPath(url) {
  const id = createHash("sha1").update(`${MEDIA_CACHE_VERSION}:${url}`).digest("hex");
  return join(MEDIA_CACHE_DIR, `${id}.mp4`);
}

/**
 * WhatsApp GIF messages are silent, short MP4 videos with gifPlayback=true.
 * The card API includes animated GIFs and WebPs that can be 10–25 MB. Sending
 * those URLs directly makes WhatsApp show them as heavy image media. Convert
 * them to a compact MP4 before sending.
 */
async function getGifVideo(url) {
  if (CARD_VIDEO_CACHE.has(url)) return CARD_VIDEO_CACHE.get(url);

  const pending = (async () => {
    const output = cardVideoPath(url);
    if (existsSync(output)) return readFileSync(output);

    const sourceExt = url.toLowerCase().includes(".webp") ? ".webp" : ".gif";
    const source = join(
      MEDIA_CACHE_DIR,
      `${createHash("sha1").update(`${url}:source`).digest("hex")}${sourceExt}`,
    );

    const response = await fetch(url, { signal: AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`Card media HTTP ${response.status}`);
    const declaredSize = Number(response.headers.get("content-length") || 0);
    if (declaredSize > 20 * 1024 * 1024) throw new Error("Card animation source exceeds 20 MB");
    const sourceBuffer = Buffer.from(await response.arrayBuffer());
    if (!sourceBuffer.length || sourceBuffer.length > 20 * 1024 * 1024) throw new Error("Card animation source exceeds 20 MB");
    writeFileSync(source, sourceBuffer);

    try {
      await execFileAsync("ffmpeg", [
        "-hide_banner",
        "-loglevel", "error",
        "-y",
        "-i", source,
        "-t", "6",
        "-vf", "fps=10,scale=360:360:force_original_aspect_ratio=decrease,"
          + "pad=360:360:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p",
        "-an",
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", "30",
        "-profile:v", "baseline",
        "-level", "3.0",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        output,
      ], { timeout: 120_000, maxBuffer: 1024 * 1024 });
      return readFileSync(output);
    } finally {
      try { unlinkSync(source); } catch {}
    }
  })();

  CARD_VIDEO_CACHE.set(url, pending);
  try {
    return await pending;
  } catch (error) {
    CARD_VIDEO_CACHE.delete(url);
    throw error;
  }
}

/**
 * Send a card as a GIF (Tier 6 / S) or static image (all other tiers).
 * Centralises the image-vs-gif routing so every display point stays in sync.
 *
 * @param {object} sock     Baileys socket
 * @param {string} jid      Chat JID to send to
 * @param {object} card     Card object (must have .media, .tierNum, .mediaType)
 * @param {string} caption  Caption text
 * @param {object} [extra]  Extra sendMessage options (e.g. { quoted: msg, mentions: [...] })
 */
export async function sendCardMedia(sock, jid, card, caption, extra = {}) {
  if (!card.media) {
    return sock.sendMessage(jid, { text: caption, ...extra });
  }
  const url = await resolveMediaUrl(card.media);
  const tier = String(card.tierNum ?? card.tier ?? "").trim().toUpperCase();
  const mediaType = String(card.mediaType ?? "").toLowerCase();
  const isGif = tier === "6" || tier === "S" || tier === "SECRET" || tier.includes("SECRET") || mediaType.includes("gif") || mediaType.includes("animated");
  if (isGif) {
    try {
      const video = await getGifVideo(url);
      return sock.sendMessage(
        jid,
        { video, mimetype: "video/mp4", gifPlayback: true, caption, ...extra },
      );
    } catch (error) {
      console.error(`[cardApi] GIF conversion failed: ${error.message}`);
      const fallbackImage = card.thumbnail || card.thumbnailUrl || card.mediaFallbacks?.[0];
      if (fallbackImage) return sock.sendMessage(jid, { image: { url: fallbackImage }, caption, ...extra });
      return sock.sendMessage(jid, { text: caption, ...extra });
    }
  }
  return sock.sendMessage(jid, { image: { url }, caption, ...extra });
}
