import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createCafe } from "./cafe.js";
import { registerTools, tools } from "./webmcp.js";

const menu = JSON.parse(await readFile(new URL("./data/menu.json", import.meta.url), "utf8"));
const cafeForTest = () => createCafe(menu, { now: () => new Date("2026-10-19T17:00:00Z") });

test("ordinary tool responses omit the calendar while retaining exact cart values", (t) => {
  const cafe = cafeForTest();
  const search = cafe.execute("search_menu", { query: "cinnamon roll", inStockOnly: false });
  assert.equal(search.products[0].stock, 0);
  assert.equal(Object.hasOwn(search, "pickupSlots"), false);
  assert.ok(JSON.stringify(search).length < 2000);
  cafe.execute("add_to_cart", { items: [{ productId: "latte", quantity: 2, options: { temperature: "iced", extra: "vanilla" } }] });
  const update = cafe.execute("update_cart", { changes: [{ lineId: "line-1", options: { size: "large", milk: "oat" } }] });
  assert.equal(update.cart.lines[0].unitPriceCents, 725);
  assert.equal(update.cart.totalCents, 1450);
  assert.equal(update.cartVersion, 2);
  assert.equal(Object.hasOwn(update, "pickupSlots"), false);
  assert.ok(JSON.stringify(update).length < 2000);
  t.diagnostic(`Compact response sizes: search ${JSON.stringify(search).length} chars; cart update ${JSON.stringify(update).length} chars.`);
  assert.ok(cafe.pickupSlots().length > 20, "the UI still has the complete calendar");
});

test("pickup lookup is bounded, filters dates and capacity, and paginates without duplicates", () => {
  const cafe = cafeForTest();
  const first = cafe.execute("get_pickup_slots");
  assert.equal(first.pickupSlots.length, 8);
  assert.equal(first.currentDate, "2026-10-19");
  const next = cafe.execute("get_pickup_slots", { after: first.nextAfter });
  assert.ok(next.pickupSlots.every((slot) => slot.id > first.nextAfter));
  const full = cafe.execute("get_pickup_slots", { date: "2026-10-20", after: "2026-10-20T15:00", limit: 2 });
  assert.deepEqual(full.pickupSlots.map(({ time, remaining }) => [time, remaining]), [["15:30", 0], ["16:00", 6]]);
  const available = cafe.execute("get_pickup_slots", { date: "2026-10-20", after: "2026-10-20T15:00", includeFull: false, limit: 1 });
  assert.equal(available.pickupSlots[0].id, "2026-10-20T16:00");
  assert.throws(() => cafe.execute("get_pickup_slots", { limit: 21 }));
  assert.throws(() => cafe.execute("get_pickup_slots", { date: "2026-02-30" }));
  assert.throws(() => cafe.execute("get_pickup_slots", { includeFull: "false" }));
});

test("a returned slot and current version can finalize pickup", () => {
  const cafe = cafeForTest();
  const cart = cafe.execute("add_to_cart", { items: [{ productId: "americano", quantity: 1 }] });
  const slots = cafe.execute("get_pickup_slots", { includeFull: false, limit: 1 });
  const receipt = cafe.execute("schedule_pickup", { slotId: slots.pickupSlots[0].id, customerName: "Alex", cartVersion: cart.cartVersion });
  assert.equal(receipt.order.totalCents, 350);
  assert.equal(receipt.order.customerName, "Alex");
  assert.equal(receipt.cart.itemCount, 0);
});

test("registered tools return structured business errors without losing details", async () => {
  const previous = globalThis.document;
  const registered = [];
  globalThis.document = { modelContext: { registerTool: async (tool) => registered.push(tool) } };
  try {
    const cafe = cafeForTest();
    await registerTools((name, args) => cafe.execute(name, args));
    assert.equal(registered.length, tools.length);
    const add = registered.find((tool) => tool.name === "add_to_cart");
    const result = await add.execute({ items: [{ productId: "almond-croissant", quantity: 4 }] });
    assert.equal(result.ok, false);
    assert.equal(result.code, "OUT_OF_STOCK");
    assert.match(result.error, /Only 3 Almond croissant available/);
    assert.equal(cafe.snapshot().cart.itemCount, 0);
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});
