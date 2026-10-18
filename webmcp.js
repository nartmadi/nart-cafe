const string = (description) => ({ type: "string", description });
const integer = (description, minimum, maximum) => ({ type: "integer", description, minimum, maximum });
const object = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const options = {
  type: "object",
  description: "Use supported options returned by get_product or search_menu. Omitted options use the product defaults.",
  properties: {
    size: { type: "string", enum: ["regular", "large"] },
    temperature: { type: "string", enum: ["hot", "iced"] },
    milk: { type: "string", enum: ["whole", "oat", "almond", "soy"] },
    extra: { type: "string", enum: ["none", "extra-shot", "vanilla"] },
  },
  additionalProperties: false,
};

export const tools = [
  {
    name: "search_menu",
    description: "Find café products and the lowest-priced configurations matching dietary needs, ingredients, temperature, and budget. Prices are tax-inclusive USD cents before discounts. Results include the current cart, public promotions, and dated pickup slots in America/Los_Angeles. Ingredient exclusions and cross-contact are separate.",
    annotations: { readOnlyHint: true },
    inputSchema: object({
      query: string("Words in the product name, description, or configured ingredients, e.g. iced latte or oat."),
      category: { type: "string", enum: ["coffee", "tea", "cold-drinks", "bakery", "food"] },
      dietary: { type: "array", items: { type: "string", enum: ["vegan", "vegetarian", "dairy-free", "gluten-free"] }, description: "All preferences must match the configured ingredients." },
      excludeAllergens: { type: "array", items: string("milk, egg, wheat, soy, peanuts, tree nuts, sesame, fish, or shellfish"), description: "Exclude contained allergens. Dairy and gluten are accepted as aliases for milk and wheat." },
      excludeCrossContact: { type: "boolean", description: "Also exclude shared-equipment risks for the requested allergens. Default false." },
      temperature: { type: "string", enum: ["hot", "iced"] },
      maxPriceCents: integer("Maximum customized unit price in USD cents.", 0, 100000),
      quantity: integer("Number of each matching item to check against stock and maxTotalCents. Default 1.", 1, 10),
      maxTotalCents: integer("Maximum price for quantity units of a matching configuration, before discounts.", 0, 1000000),
      inStockOnly: { type: "boolean", description: "Default true. Set false to inspect sold-out products." },
    }),
  },
  {
    name: "get_product",
    description: "Read a product's supported modifiers, exact configured price, ingredients, allergens, cross-contact, stock, and dietary tags. Opens its details on the page.",
    annotations: { readOnlyHint: true },
    inputSchema: object({ productId: string("Product ID returned by search_menu."), options }, ["productId"]),
  },
  {
    name: "add_to_cart",
    description: "Add one or several customized products to the order in one call. Validates all items atomically, merges identical configurations, and returns cart line IDs, exact totals, cartVersion, offers, and pickup slots. Nothing changes if any item is invalid.",
    inputSchema: object({ items: { type: "array", minItems: 1, maxItems: 10, items: object({ productId: string("Product ID."), quantity: integer("Units to add; at most 10 per identical configuration in the cart.", 1, 10), options }, ["productId", "quantity"]) } }, ["items"]),
  },
  {
    name: "update_cart",
    description: "Update one or several cart lines atomically. Set quantity to zero to remove a line; otherwise change quantity or patch supported options. Returns the updated cart and removes a discount if the order no longer qualifies.",
    inputSchema: object({ changes: { type: "array", minItems: 1, maxItems: 50, items: object({ lineId: string("Cart line ID returned by a previous tool response, e.g. line-1."), quantity: integer("New quantity. Zero removes the item.", 0, 10), options }, ["lineId"]) } }, ["changes"]),
  },
  {
    name: "apply_discount",
    description: "Apply one public promotion to the cart. Codes and eligibility are listed in search and cart responses. Replaces an existing code rather than stacking discounts. Returns recalculated totals and cartVersion; invalid codes leave the cart unchanged.",
    inputSchema: object({ code: string("Promotion code, case-insensitive.") }, ["code"]),
  },
  {
    name: "schedule_pickup",
    description: "Finalize the current order for pickup. Revalidates stock, the selected slot, and cartVersion before creating an order number and receipt. Use a slot ID returned in pickupSlots and the latest cartVersion. Repeating the same successful request returns the existing receipt without duplicating the order. Pay at pickup.",
    annotations: { consequentialHint: true },
    inputSchema: object({
      slotId: string("Exact dated pickup slot ID returned by search or cart responses; choose a slot with remaining > 0."),
      customerName: string("Name for pickup, 1–80 characters."),
      cartVersion: integer("Latest cartVersion returned after the last cart or discount change.", 0, Number.MAX_SAFE_INTEGER),
    }, ["slotId", "customerName", "cartVersion"]),
  },
];

export async function registerTools(execute) {
  // document.modelContext is the current API; older preview browsers use navigator.
  const context = document.modelContext ?? navigator.modelContext;
  if (typeof context?.registerTool !== "function") return;
  for (const definition of tools) {
    try {
      await context.registerTool({ ...definition, execute: (args) => execute(definition.name, args) });
    } catch (error) {
      console.error(`Could not register ${definition.name}.`, error);
    }
  }
}
