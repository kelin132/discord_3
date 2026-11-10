import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import {
  fetchRandomCard,
  normalise,
  pickRandomTier,
  TIER_NAME,
  TIER_NUM,
  TIER_PRICE,
  TIER_WEIGHTS,
} from "../lib/cardApi.mjs";

const WHATSAPP_TIERS = ["1", "2", "3", "4", "5", "6", "S", "C", "R", "SR", "SSR", "UR", "X"];

test("every configured card tier can be selected by the weighted spawn picker", () => {
  const total = TIER_WEIGHTS.reduce((sum, tier) => sum + tier.weight, 0);
  let precedingWeight = 0;
  for (const tier of TIER_WEIGHTS) {
    const sample = (precedingWeight + tier.weight / 2) / total;
    assert.equal(pickRandomTier(() => sample), tier.num);
    precedingWeight += tier.weight;
  }
});

test("the picker can limit its choices to tiers present in a catalog", () => {
  const available = TIER_WEIGHTS.filter((tier) => ["1", "X"].includes(tier.num));
  assert.equal(pickRandomTier(() => 0.99, available), "X");
});

test("Discord supports and can randomly spawn every WhatsApp card tier", () => {
  assert.deepEqual(TIER_WEIGHTS.map(({ num }) => num), WHATSAPP_TIERS);
  for (const tier of WHATSAPP_TIERS) {
    assert.ok(TIER_NAME[tier], `tier ${tier} has a display name`);
    assert.ok(TIER_PRICE[TIER_NAME[tier]], `tier ${tier} has a paid claim price range`);
    assert.equal(TIER_NUM[tier.toLowerCase()], tier);
  }
});

test("normalizes high tier cards with their shared prices and animated media", () => {
  const card = normalise({
    id: "x-card-1",
    tier: "X",
    title: "Animated X card",
    image: "https://cards.example/x-card.gif",
    media_type: "gif",
    value: 25_000_000,
    value_currency: "coins",
  });

  assert.equal(card.tierNum, "X");
  assert.equal(card.tier, "X");
  assert.equal(card.price, 25_000_000);
  assert.equal(card.mediaType, "gif");
  assert.equal(card.media, "https://cards.example/x-card.gif");
});

test("fetches SR cards using the same tiered random endpoint as WhatsApp", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl;
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({
      success: true,
      card: {
        id: "sr-card-1",
        tier: "SR",
        title: "SR test card",
        image: "https://cards.example/sr-card.jpg",
        value: 1_500_000,
        value_currency: "coins",
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    const card = await fetchRandomCard("SR");
    assert.equal(requestedUrl, "https://cardapi.eulaorg.app/api/random?tier=SR");
    assert.equal(card.tierNum, "SR");
    assert.equal(card.price, 1_500_000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the .spack shortcut is not registered in Discord", () => {
  assert.equal(
    existsSync(new URL("../plugins/cards/spawnpack.js", import.meta.url)),
    false,
  );
});
