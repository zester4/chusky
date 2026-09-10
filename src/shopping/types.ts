export type ShoppingCategory = "groceries" | "household" | "meal_kit" | "fashion" | "electronics" | "health_beauty" | "home" | "other";
export type ShoppingRunStatus = "awaiting_details" | "awaiting_retailer" | "awaiting_connection" | "awaiting_user_interaction" | "ready_to_shop" | "shopping" | "cart_ready" | "completed" | "cancelled";

export type ShoppingPauseReason = "captcha" | "two_factor" | "age_verification" | "site_challenge" | "login" | "user_requested";

export interface ShoppingRetailer {
  id: string;
  name: string;
  origin: string;
  countries: string[];
  categories: ShoppingCategory[];
  supportsDelivery: boolean;
  supportsPickup: boolean;
}

export interface ShoppingRun {
  id: string;
  userId: number;
  items: string[];
  category: ShoppingCategory;
  status: ShoppingRunStatus;
  retailer?: ShoppingRetailer;
  country?: string;
  city?: string;
  postcode?: string;
  budget?: number;
  currency?: string;
  deliveryPreference?: "delivery" | "pickup" | "either";
  notes?: string;
  pausedReason?: ShoppingPauseReason;
  pausedAt?: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

/** A user-owned retailer preference. It intentionally never includes credentials or cookies. */
export interface ShoppingSite {
  id: string;
  userId: number;
  name: string;
  origin: string;
  countries: string[];
  categories: ShoppingCategory[];
  supportsDelivery: boolean;
  supportsPickup: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ShoppingStartInput {
  items: string[];
  category?: ShoppingCategory;
  retailer?: string;
  country?: string;
  city?: string;
  postcode?: string;
  budget?: number;
  currency?: string;
  deliveryPreference?: "delivery" | "pickup" | "either";
  notes?: string;
}
