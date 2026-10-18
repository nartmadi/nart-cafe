// Prices are tax-inclusive USD cents. State belongs to one page session.
export class CafeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CafeError";
    this.code = code;
  }
}

const fail = (code, message) => { throw new CafeError(code, message); };
const unique = (values) => [...new Set(values)];
const clone = (value) => structuredClone(value);
const money = (cents) => `$${(cents / 100).toFixed(2)}`;

function object(value, keys, label = "Arguments") {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_INPUT", `${label} must be an object.`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail("INVALID_INPUT", `Unknown ${label.toLowerCase()} field: ${key}.`);
}

function text(value, label, max = 100, allowEmpty = false) {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > max || /[\u0000-\u001f]/.test(value)) {
    fail("INVALID_INPUT", `${label} must be ${allowEmpty ? "up to" : "1–"}${max} characters.`);
  }
  return value.trim();
}

function integer(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail("INVALID_INPUT", `${label} must be a whole number from ${min} to ${max}.`);
  return value;
}

function list(value, label, min = 0, max = 10) {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail("INVALID_INPUT", `${label} must contain ${min}–${max} items.`);
  return value;
}

function localParts(date, timezone) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

function slotInstant(date, time, timezone) {
  const target = Date.parse(`${date}T${time}:00Z`);
  let instant = target;
  for (let i = 0; i < 3; i++) {
    const p = localParts(new Date(instant), timezone);
    const represented = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`);
    instant += target - represented;
  }
  return instant;
}

export function createCafe(source, { now = () => new Date() } = {}) {
  const data = clone(source);
  const products = new Map(data.products.map((product) => [product.id, product]));
  const stock = new Map(data.products.map((product) => [product.id, product.stock]));
  const usedSlots = new Map();
  const completed = new Map();
  let cart = [];
  let discountCode = null;
  let version = 0;
  let nextLine = 1;
  let lastOrder = null;

  function productFor(id) {
    const product = products.get(text(id, "Product ID"));
    if (!product) fail("PRODUCT_NOT_FOUND", `Product ${id} was not found. Search the menu for an available product.`);
    return product;
  }

  function configure(productId, options = {}) {
    const product = productFor(productId);
    const profile = data.profiles[product.profile];
    object(options, Object.keys(profile), "Options");
    const selected = {};
    const ingredients = [...product.ingredients];
    const allergens = [...product.allergens];
    const labels = [];
    let price = product.priceCents;
    let vegan = product.vegan;
    for (const [group, values] of Object.entries(profile)) {
      const value = Object.hasOwn(options, group) ? options[group] : values[0];
      if (!values.includes(value)) fail("INVALID_OPTION", `${product.name}: ${group} must be ${values.join(", ")}.`);
      const option = data.optionGroups[group][value];
      selected[group] = value;
      price += option.priceCents;
      ingredients.push(...option.ingredients);
      allergens.push(...option.allergens);
      if (option.vegan === false) vegan = false;
      if (value !== "none") labels.push(option.label);
    }
    const dietary = ["vegetarian"];
    if (vegan) dietary.push("vegan");
    if (!allergens.includes("milk")) dietary.push("dairy-free");
    if (product.glutenFree && !allergens.includes("wheat")) dietary.push("gluten-free");
    return {
      productId, name: product.name, category: product.category, description: product.description,
      options: selected, optionLabels: labels, unitPriceCents: price, ingredients: unique(ingredients),
      allergens: unique(allergens), crossContact: [...product.crossContact], dietary, stock: stock.get(productId),
    };
  }

  function configurations(product) {
    let combinations = [{}];
    for (const [group, values] of Object.entries(data.profiles[product.profile])) {
      combinations = combinations.flatMap((options) => values.map((value) => ({ ...options, [group]: value })));
    }
    return combinations.map((options) => configure(product.id, options));
  }

  function pickupSlots() {
    const current = now();
    const parts = localParts(current, data.timezone);
    const today = `${parts.year}-${parts.month}-${parts.day}`;
    const slots = [];
    const hours = data.hours;
    for (let day = 0; day < hours.daysAhead; day++) {
      const date = new Date(Date.parse(`${today}T12:00:00Z`) + day * 86400000).toISOString().slice(0, 10);
      for (let minutes = hours.open * 60; minutes < hours.close * 60; minutes += hours.intervalMinutes) {
        const time = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
        const id = `${date}T${time}`;
        if (slotInstant(date, time, data.timezone) < current.getTime() + hours.leadMinutes * 60000) continue;
        const remaining = hours.fullTimes.includes(time) ? 0 : Math.max(0, hours.slotCapacity - (usedSlots.get(id) ?? 0));
        const displayTime = `${Math.floor(minutes / 60) % 12 || 12}:${String(minutes % 60).padStart(2, "0")} ${minutes < 720 ? "AM" : "PM"}`;
        slots.push({ id, date, time, label: `${day === 0 ? "Today" : day === 1 ? "Tomorrow" : date}, ${displayTime}`, remaining });
      }
    }
    return slots;
  }

  function eligibility(promo, lines = cart) {
    if (!lines.length) return "Add an item before applying a discount.";
    if (promo.status !== "active") return "This promotion has expired.";
    const subtotal = lines.reduce((sum, line) => sum + line.unitPriceCents * line.quantity, 0);
    if (subtotal < promo.minimumCents) return `This code requires an order of at least ${money(promo.minimumCents)}.`;
    if (lines.reduce((sum, line) => sum + line.quantity, 0) < promo.minimumItems) return `This code requires at least ${promo.minimumItems} items.`;
    return null;
  }

  function snapshot() {
    const subtotal = cart.reduce((sum, line) => sum + line.unitPriceCents * line.quantity, 0);
    const promo = data.promotions.find((entry) => entry.code === discountCode);
    const discount = promo && !eligibility(promo) ? Math.min(subtotal, promo.type === "percent" ? Math.round(subtotal * promo.value / 100) : promo.value) : 0;
    return clone({
      currency: data.currency, timezone: data.timezone, cartVersion: version,
      cart: { lines: cart, itemCount: cart.reduce((sum, line) => sum + line.quantity, 0), subtotalCents: subtotal, discountCode, discountCents: discount, totalCents: subtotal - discount },
      promotions: data.promotions.filter((entry) => entry.status === "active").map((entry) => ({ code: entry.code, description: entry.description, eligible: !eligibility(entry), reason: eligibility(entry) })),
      pickupSlots: pickupSlots(), order: lastOrder,
    });
  }

  function validateCart(lines) {
    let count = 0;
    const quantities = new Map();
    for (const line of lines) {
      integer(line.quantity, "Quantity per customized item", 1, 10);
      count += line.quantity;
      quantities.set(line.productId, (quantities.get(line.productId) ?? 0) + line.quantity);
    }
    if (count > 50) fail("CART_LIMIT", "An order can contain at most 50 items.");
    for (const [id, quantity] of quantities) {
      if (quantity > stock.get(id)) fail("OUT_OF_STOCK", `Only ${stock.get(id)} ${productFor(id).name} available. Reduce the quantity or choose another item.`);
    }
  }

  const sameItem = (a, b) => a.productId === b.productId && JSON.stringify(a.options) === JSON.stringify(b.options);

  function saveCart(lines) {
    validateCart(lines);
    cart = lines;
    version++;
    let notice = null;
    if (discountCode) {
      const promo = data.promotions.find((entry) => entry.code === discountCode);
      if (eligibility(promo)) {
        notice = `${discountCode} removed: ${eligibility(promo)}`;
        discountCode = null;
      }
    }
    return { ok: true, notice, ...snapshot() };
  }

  const actions = {
    search_menu(args) {
      object(args, ["query", "category", "dietary", "excludeAllergens", "excludeCrossContact", "temperature", "maxPriceCents", "quantity", "maxTotalCents", "inStockOnly"]);
      const query = text(args.query ?? "", "Query", 150, true).toLowerCase();
      if (args.category !== undefined && !data.categories.some((entry) => entry.id === args.category)) fail("INVALID_INPUT", "Choose a category from coffee, tea, cold-drinks, bakery, or food.");
      if (args.temperature !== undefined && !["hot", "iced"].includes(args.temperature)) fail("INVALID_INPUT", "Temperature must be hot or iced.");
      for (const key of ["excludeCrossContact", "inStockOnly"]) if (args[key] !== undefined && typeof args[key] !== "boolean") fail("INVALID_INPUT", `${key} must be a boolean.`);
      const dietary = list(args.dietary ?? [], "Dietary preferences", 0, 4);
      for (const tag of dietary) if (!["vegan", "vegetarian", "dairy-free", "gluten-free"].includes(tag)) fail("INVALID_INPUT", `Unknown dietary preference: ${tag}.`);
      const allergens = list(args.excludeAllergens ?? [], "Allergens", 0, 9).map((entry) => {
        const value = text(entry, "Allergen").toLowerCase();
        const normalized = ({ dairy: "milk", gluten: "wheat", peanut: "peanuts", "tree nut": "tree nuts" })[value] ?? value;
        if (!data.allergens.includes(normalized)) fail("INVALID_INPUT", `Unknown allergen: ${value}. Supported allergens: ${data.allergens.join(", ")}.`);
        return normalized;
      });
      const quantity = integer(args.quantity ?? 1, "Quantity", 1, 10);
      const maxPrice = integer(args.maxPriceCents ?? 100000, "Maximum price in cents", 0, 100000);
      const maxTotal = integer(args.maxTotalCents ?? 1000000, "Maximum total in cents", 0, 1000000);
      const results = [];
      for (const product of data.products) {
        if (args.category && product.category !== args.category) continue;
        if (args.inStockOnly !== false && stock.get(product.id) < quantity) continue;
        const candidates = configurations(product).filter((item) => {
          const searchable = `${item.name} ${item.description} ${item.category} ${item.ingredients.join(" ")} ${item.optionLabels.join(" ")}`.toLowerCase();
          return query.split(/\s+/).every((word) => searchable.includes(word)) && dietary.every((tag) => item.dietary.includes(tag)) &&
            !allergens.some((allergen) => item.allergens.includes(allergen) || (args.excludeCrossContact && item.crossContact.includes(allergen))) &&
            (!args.temperature || item.options.temperature === args.temperature) && item.unitPriceCents <= maxPrice && item.unitPriceCents * quantity <= maxTotal;
        }).sort((a, b) => a.unitPriceCents - b.unitPriceCents);
        if (candidates.length) results.push({ ...candidates[0], quantity, totalPriceCents: candidates[0].unitPriceCents * quantity });
      }
      return { ok: true, products: results, allergenPolicy: "Exclusions apply to contained ingredients. Cross-contact is listed separately; excludeCrossContact also filters it.", ...snapshot() };
    },
    get_product(args) {
      object(args, ["productId", "options"]);
      const product = productFor(args.productId);
      const optionGroups = Object.entries(data.profiles[product.profile]).map(([id, values]) => ({ id, values: values.map((value) => ({ id: value, ...data.optionGroups[id][value] })) }));
      return { ok: true, product: { ...configure(product.id, args.options), optionGroups }, ...snapshot() };
    },
    add_to_cart(args) {
      object(args, ["items"]);
      const items = list(args.items, "Items", 1, 10);
      const next = clone(cart);
      let lineNumber = nextLine;
      for (const item of items) {
        object(item, ["productId", "quantity", "options"], "Item");
        const configuration = configure(item.productId, item.options);
        const quantity = integer(item.quantity, "Quantity", 1, 10);
        const existing = next.find((line) => sameItem(line, configuration));
        if (existing) existing.quantity += quantity;
        else next.push({ ...configuration, lineId: `line-${lineNumber++}`, quantity });
      }
      const result = saveCart(next);
      nextLine = lineNumber;
      return result;
    },
    update_cart(args) {
      object(args, ["changes"]);
      const changes = list(args.changes, "Changes", 1, 50);
      let next = clone(cart);
      const seen = new Set();
      for (const change of changes) {
        object(change, ["lineId", "quantity", "options"], "Change");
        const id = text(change.lineId, "Cart line ID");
        if (seen.has(id)) fail("INVALID_INPUT", "Change each cart line only once per request.");
        seen.add(id);
        const index = next.findIndex((line) => line.lineId === id);
        if (index < 0) fail("LINE_NOT_FOUND", `Cart line ${id} was not found. Use a line ID from the current cart.`);
        if (change.quantity === undefined && change.options === undefined) fail("INVALID_INPUT", "Provide a quantity or options to update.");
        const quantity = change.quantity === undefined ? next[index].quantity : integer(change.quantity, "Quantity", 0, 10);
        if (change.options !== undefined) object(change.options, Object.keys(data.profiles[productFor(next[index].productId).profile]), "Options");
        if (quantity === 0) next.splice(index, 1);
        else next[index] = { ...configure(next[index].productId, { ...next[index].options, ...change.options }), lineId: id, quantity };
      }
      const merged = [];
      for (const line of next) {
        const existing = merged.find((item) => sameItem(item, line));
        if (existing) existing.quantity += line.quantity;
        else merged.push(line);
      }
      return saveCart(merged);
    },
    apply_discount(args) {
      object(args, ["code"]);
      const code = text(args.code, "Discount code", 30).toUpperCase();
      const promo = data.promotions.find((entry) => entry.code === code);
      if (!promo) fail("INVALID_DISCOUNT", "Code not recognized. Available offers are listed with your order.");
      const reason = eligibility(promo);
      if (reason) fail("INELIGIBLE_DISCOUNT", reason);
      if (discountCode !== code) { discountCode = code; version++; }
      return { ok: true, ...snapshot() };
    },
    schedule_pickup(args) {
      object(args, ["slotId", "customerName", "cartVersion"]);
      const slotId = text(args.slotId, "Pickup slot", 30);
      const customerName = text(args.customerName, "Name", 80);
      const cartVersion = integer(args.cartVersion, "Cart version", 0, Number.MAX_SAFE_INTEGER);
      const request = JSON.stringify([cartVersion, slotId, customerName]);
      if (completed.has(request)) return { ok: true, ...snapshot(), order: clone(completed.get(request)), replayed: true };
      if (cartVersion !== version) fail("CART_CHANGED", "Your order changed. Review the current total and use its cartVersion to schedule pickup.");
      if (!cart.length) fail("EMPTY_CART", "Add an item before scheduling pickup.");
      const slot = pickupSlots().find((entry) => entry.id === slotId);
      if (!slot) fail("INVALID_SLOT", "That time is no longer available. Choose a current pickup slot.");
      if (!slot.remaining) fail("SLOT_FULL", "That pickup time is full. Choose another available time.");
      validateCart(cart);
      const receipt = snapshot().cart;
      lastOrder = { orderNumber: `SC-${1001 + completed.size}`, customerName, pickup: slot, timezone: data.timezone, ...receipt };
      for (const line of cart) stock.set(line.productId, stock.get(line.productId) - line.quantity);
      usedSlots.set(slotId, (usedSlots.get(slotId) ?? 0) + 1);
      completed.set(request, clone(lastOrder));
      cart = [];
      discountCode = null;
      version++;
      return { ok: true, ...snapshot(), replayed: false };
    },
  };

  return {
    configure,
    snapshot,
    execute(name, args = {}) {
      if (!Object.hasOwn(actions, name)) fail("UNKNOWN_ACTION", "That action is not available.");
      return clone(actions[name](args));
    },
  };
}
