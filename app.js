import { createCafe } from "./cafe.js";
import { registerTools } from "./webmcp.js";

const $ = (id) => document.getElementById(id);
const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const price = (cents) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const groupLabels = { size: "Size", temperature: "Temperature", milk: "Milk", extra: "Extra" };
let cafe;
let catalog;
let filters = { inStockOnly: false };
let results = [];
let openedProduct = null;
let editingLine = null;
let productTrigger = null;

function announce(message, error = false) {
  const status = $("status");
  if (!status) return;
  status.textContent = message;
  status.className = `status-message${error ? " error" : ""}`;
}

function inline(id, message, error = false) {
  $(id).textContent = message ?? "";
  $(id).className = `inline-message${error ? " error" : ""}`;
}

function execute(name, args = {}) {
  try {
    const result = cafe.execute(name, args);
    if (name === "search_menu") {
      filters = { ...args };
      results = result.products;
      $("query").value = args.query ?? "";
      $("dietary").value = args.dietary?.length === 1 ? args.dietary[0] : "";
      renderMenu();
    } else if (name === "get_product") {
      openProduct(result.product);
    } else {
      results = cafe.execute("search_menu", filters).products;
      renderMenu();
      if (name === "add_to_cart" || name === "update_cart") {
        $("product-dialog").close();
        announce(name === "add_to_cart" ? "Added to your order." : "Order updated.");
      }
      inline("cart-message", result.notice ?? (name === "apply_discount" ? `${result.cart.discountCode} applied.` : ""));
      inline("pickup-message", "");
    }
    renderCart(result);
    if (name === "schedule_pickup") {
      announce(`Order ${result.order.orderNumber} placed for ${result.order.pickup.label}.`);
      $("confirmation").scrollIntoView({ block: "nearest" });
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Please try again.";
    announce(message, true);
    const target = name === "schedule_pickup" ? "pickup-message" : name === "apply_discount" || name === "update_cart" ? "cart-message" : "product-message";
    inline(target, message, true);
    throw error;
  }
}

// UI errors are already rendered by execute; native tool calls retain their rejection.
function fromUi(name, args) {
  try { return execute(name, args); } catch { return null; }
}

function searchFromForm() {
  const next = { ...filters, query: $("query").value, dietary: $("dietary").value ? [$("dietary").value] : [] };
  fromUi("search_menu", next);
  announce("");
}

function renderMenu() {
  const category = catalog.categories.find((entry) => entry.id === filters.category);
  $("category-heading").textContent = category?.name ?? "The menu";
  $("result-count").textContent = `${results.length} item${results.length === 1 ? "" : "s"}`;
  $("categories").innerHTML = [{ id: "", name: "All" }, ...catalog.categories].map((entry) => `<button type="button" class="category" data-category="${entry.id}" aria-pressed="${(filters.category ?? "") === entry.id}">${entry.name}</button>`).join("");
  $("empty-results").hidden = results.length > 0;
  $("products").innerHTML = results.map((item) => {
    const tags = [item.dietary.includes("vegan") ? "Vegan" : "", item.options.milk && item.options.milk !== "whole" ? `${catalog.optionGroups.milk[item.options.milk].label}` : "", item.stock > 0 && item.stock <= 3 ? `Only ${item.stock} left` : ""].filter(Boolean);
    return `<article class="product-card" data-product-id="${item.productId}"><h3>${escape(item.name)}</h3><p>${escape(item.description)}</p><div class="product-tags">${escape(tags.join(" · "))}</div><div class="product-card-footer"><strong>${price(item.unitPriceCents)}</strong><button class="button add" type="button" data-product="${item.productId}">${item.stock ? 'Add <span aria-hidden="true">+</span>' : "View"}<span class="sr-only"> ${escape(item.name)}</span></button></div>${item.stock ? "" : '<span class="sold-out">Sold out today</span>'}</article>`;
  }).join("");
}

function renderCart(snapshot = cafe.snapshot()) {
  const active = document.activeElement;
  const focusKey = active?.dataset.focus;
  const { cart, pickupSlots, promotions, order } = snapshot;
  if ($("cart-count")) $("cart-count").textContent = cart.itemCount;
  $("cart-empty").hidden = cart.lines.length > 0 || Boolean(order);
  $("cart-summary").hidden = !cart.lines.length;
  $("cart-lines").innerHTML = cart.lines.map((line) => `<article class="cart-line" data-line-id="${line.lineId}"><div class="cart-line-top"><strong>${escape(line.name)}</strong><span>${price(line.unitPriceCents * line.quantity)}</span></div><p>${escape(line.optionLabels.join(" · ") || "Made fresh")}</p><div class="cart-line-controls"><div class="quantity-control"><button type="button" data-change="${line.lineId}" data-quantity="${line.quantity - 1}" data-focus="minus-${line.lineId}" aria-label="Decrease ${escape(line.name)} quantity">−</button><span>${line.quantity}</span><button type="button" data-change="${line.lineId}" data-quantity="${line.quantity + 1}" data-focus="plus-${line.lineId}" aria-label="Increase ${escape(line.name)} quantity" ${line.quantity >= 10 ? "disabled" : ""}>+</button></div><div><button class="text-button" type="button" data-edit="${line.lineId}">Edit</button><span aria-hidden="true"> · </span><button class="text-button" type="button" data-change="${line.lineId}" data-quantity="0" aria-label="Remove ${escape(line.name)}">Remove</button></div></div></article>`).join("");
  if (focusKey) document.querySelector(`[data-focus="${focusKey}"]`)?.focus({ preventScroll: true });
  $("subtotal").textContent = price(cart.subtotalCents);
  $("total").textContent = price(cart.totalCents);
  $("discount-row").hidden = !cart.discountCode;
  $("discount-label").textContent = cart.discountCode ?? "Discount";
  $("discount-total").textContent = `−${price(cart.discountCents)}`;
  const selectedSlot = $("pickup-slot").value;
  $("pickup-slot").innerHTML = '<option value="">Choose a time</option>' + pickupSlots.map((slot) => `<option value="${slot.id}" ${slot.remaining ? "" : "disabled"}>${escape(slot.label)}${slot.remaining ? "" : " — full"}</option>`).join("");
  if (pickupSlots.some((slot) => slot.id === selectedSlot && slot.remaining)) $("pickup-slot").value = selectedSlot;
  $("schedule-button").disabled = !cart.lines.length || !pickupSlots.some((slot) => slot.remaining);
  $("offers").innerHTML = promotions.map((offer) => `<div class="offer"><code>${offer.code}</code><p>${escape(offer.description)}</p></div>`).join("");
  $("offers").closest("details").hidden = Boolean(order) && !cart.lines.length;
  $("confirmation").hidden = !order;
  if (order) $("confirmation").innerHTML = `<h3 id="confirmation-heading">You're all set, ${escape(order.customerName)}.</h3><p>Order <strong id="order-number">${order.orderNumber}</strong> · <span id="confirmed-pickup">${escape(order.pickup.label)}</span></p><ul>${order.lines.map((line) => `<li>${line.quantity} × ${escape(line.name)}${line.optionLabels.length ? ` (${escape(line.optionLabels.join(", "))})` : ""}</li>`).join("")}</ul><p><strong id="confirmed-total">${price(order.totalCents)}</strong> · Pay at pickup</p>`;
  $("mobile-order").hidden = !cart.lines.length;
  $("mobile-count").textContent = `(${cart.itemCount})`;
  $("mobile-total").textContent = price(cart.totalCents);
}

function openProduct(product) {
  const active = document.activeElement;
  if (!$("product-dialog").open) productTrigger = active?.dataset.product ? { product: active.dataset.product } : active?.dataset.edit ? { line: active.dataset.edit } : null;
  openedProduct = product;
  editingLine = null;
  $("product-category").textContent = catalog.categories.find((category) => category.id === product.category).name;
  $("product-title").textContent = product.name;
  $("product-description").textContent = product.description;
  $("product-quantity").value = 1;
  $("product-options").innerHTML = product.optionGroups.map((group) => `<label class="field" for="option-${group.id}">${groupLabels[group.id]}<select id="option-${group.id}" data-option="${group.id}">${group.values.map((option) => `<option value="${option.id}" ${product.options[group.id] === option.id ? "selected" : ""}>${escape(option.label)}${option.priceCents ? ` (+${price(option.priceCents)})` : ""}</option>`).join("")}</select></label>`).join("");
  inline("product-message", "");
  updateProduct();
  if (!$("product-dialog").open) $("product-dialog").showModal();
}

function selectedOptions() {
  return Object.fromEntries([...$("product-options").querySelectorAll("select")].map((select) => [select.dataset.option, select.value]));
}

function updateProduct() {
  if (!openedProduct) return;
  const item = cafe.configure(openedProduct.productId, selectedOptions());
  const quantity = Number($("product-quantity").value);
  const validQuantity = Number.isInteger(quantity) && quantity >= 1 && quantity <= 10;
  $("product-ingredients").innerHTML = `<p>${escape(item.ingredients.join(", "))}.</p><p><strong>Contains:</strong> ${escape(item.allergens.join(", ") || "None of the listed allergens")}</p>${item.crossContact.length ? `<p><strong>Shared equipment:</strong> ${escape(item.crossContact.join(", "))}</p>` : ""}<p>${escape(item.dietary.join(" · "))}</p>`;
  $("add-product").disabled = !item.stock || !validQuantity;
  $("add-product").innerHTML = `${editingLine ? "Save changes" : item.stock ? "Add to order" : "Sold out"}<span id="product-price">${price(item.unitPriceCents * (validQuantity ? quantity : 1))}</span>`;
}

function bindEvents() {
  $("search-form").addEventListener("submit", (event) => { event.preventDefault(); searchFromForm(); });
  $("query").addEventListener("input", searchFromForm);
  $("dietary").addEventListener("change", searchFromForm);
  $("categories").addEventListener("click", (event) => {
    const button = event.target.closest("[data-category]");
    if (!button) return;
    if (button.dataset.category) filters.category = button.dataset.category;
    else delete filters.category;
    searchFromForm();
    document.querySelector(`[data-category="${button.dataset.category}"]`)?.focus({ preventScroll: true });
  });
  $("clear-search").addEventListener("click", () => { filters = { inStockOnly: false }; fromUi("search_menu", filters); $("query").focus(); });
  $("products").addEventListener("click", (event) => {
    const button = event.target.closest("[data-product]");
    if (!button) return;
    const item = results.find((entry) => entry.productId === button.dataset.product);
    fromUi("get_product", { productId: item.productId, options: item.options });
  });
  $("close-product").addEventListener("click", () => $("product-dialog").close());
  $("product-dialog").addEventListener("close", () => {
    if ($("product-dialog").open) return;
    openedProduct = null;
    editingLine = null;
    if (productTrigger) {
      const target = productTrigger.product ? document.querySelector(`[data-product="${productTrigger.product}"]`) : document.querySelector(`[data-edit="${productTrigger.line}"]`);
      (target ?? $("order-heading")).focus({ preventScroll: true });
    }
    productTrigger = null;
  });
  $("product-options").addEventListener("change", updateProduct);
  $("product-quantity").addEventListener("input", updateProduct);
  $("product-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const item = { productId: openedProduct.productId, quantity: Number($("product-quantity").value), options: selectedOptions() };
    if (editingLine) fromUi("update_cart", { changes: [{ lineId: editingLine, quantity: item.quantity, options: item.options }] });
    else fromUi("add_to_cart", { items: [item] });
  });
  $("cart-lines").addEventListener("click", (event) => {
    const change = event.target.closest("[data-change]");
    if (change) { fromUi("update_cart", { changes: [{ lineId: change.dataset.change, quantity: Number(change.dataset.quantity) }] }); return; }
    const edit = event.target.closest("[data-edit]");
    if (!edit) return;
    const line = cafe.snapshot().cart.lines.find((entry) => entry.lineId === edit.dataset.edit);
    fromUi("get_product", { productId: line.productId, options: line.options });
    editingLine = line.lineId;
    $("product-quantity").value = line.quantity;
    updateProduct();
  });
  $("discount-form").addEventListener("submit", (event) => { event.preventDefault(); fromUi("apply_discount", { code: $("discount-code").value }); });
  $("pickup-form").addEventListener("submit", (event) => {
    event.preventDefault();
    fromUi("schedule_pickup", { customerName: $("customer-name").value, slotId: $("pickup-slot").value, cartVersion: cafe.snapshot().cartVersion });
  });
}

async function boot() {
  try {
    const response = await fetch("data/menu.json");
    if (!response.ok) throw new Error("The menu could not load. Refresh to try again.");
    catalog = await response.json();
    cafe = createCafe(catalog);
    bindEvents();
    execute("search_menu", filters);
    $("shop").setAttribute("aria-busy", "false");
    announce("");
    await registerTools(execute);
  } catch (error) {
    $("shop").setAttribute("aria-busy", "false");
    announce(error.message ?? "The menu could not load. Refresh to try again.", true);
  }
}

void boot();
