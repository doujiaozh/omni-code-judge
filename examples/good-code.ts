/**
 * Good-code sample — deliberately exemplary: dependency injection, small pure
 * functions, typed throughout, documented, single responsibility.
 *
 * Run:  node bin/judge.js examples/good-code.ts --no-ai
 */

/** A priced product line in an order. */
export interface LineItem {
  sku: string
  name: string
  priceCents: number
  quantity: number
}

/** Pricing strategy — open for extension, closed for modification. */
export interface PricingStrategy {
  discountFor(item: LineItem, totalUnits: number): number
}

/** Bulk pricing: 10% off when the order has 10+ units of the SKU. */
export class BulkPricingStrategy implements PricingStrategy {
  constructor(private readonly bulkThreshold: number = 10, private readonly bulkRate: number = 0.1) {}

  discountFor(item: LineItem, totalUnits: number): number {
    if (totalUnits < this.bulkThreshold) return 0
    return item.priceCents * item.quantity * this.bulkRate
  }
}

/** Immutable order totals. */
export interface OrderTotals {
  readonly subtotal: number
  readonly discount: number
  readonly total: number
}

/**
 * Order service — depends on a pricing strategy injected through the
 * constructor, so the policy can be swapped without touching this class.
 */
export class OrderService {
  constructor(
    private readonly pricing: PricingStrategy,
    private readonly items: LineItem[] = [],
  ) {}

  add(item: LineItem): OrderService {
    return new OrderService(this.pricing, [...this.items, item])
  }

  /** Pure calculation with no side effects — trivially unit-testable. */
  totals(): OrderTotals {
    const subtotal = this.items.reduce((sum, item) => sum + item.priceCents * item.quantity, 0)
    const discount = this.items.reduce((sum, item) => sum + this.pricing.discountFor(item, this.unitsFor(item.sku)), 0)
    return { subtotal, discount, total: subtotal - discount }
  }

  private unitsFor(sku: string): number {
    return this.items.filter((item) => item.sku === sku).reduce((sum, item) => sum + item.quantity, 0)
  }
}

/** Format a cents amount as a display string. */
export function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}
