export type ShoppingCategory = "groceries" | "household" | "restaurant_delivery" | "meal_kit" | "dining_reservations" | "fashion" | "electronics" | "health_beauty" | "home" | "flights" | "stays" | "telecom" | "streaming" | "other";
export type ShoppingWorkflow = "product_cart" | "meal_plan" | "reservation" | "flight_search" | "stay_search" | "service_plan" | "streaming_account";
export type ShoppingRunStatus = "awaiting_details" | "awaiting_retailer" | "awaiting_connection" | "awaiting_user_interaction" | "ready_to_shop" | "shopping" | "cart_ready" | "completed" | "cancelled";

export type FlightSearchDetails = {
  origin?: string;
  destination?: string;
  departureDate?: string;
  returnDate?: string;
  passengers?: number;
  cabin?: "economy" | "premium_economy" | "business" | "first";
  nonstop?: boolean;
};

export type StaySearchDetails = {
  location?: string;
  checkIn?: string;
  checkOut?: string;
  guests?: number;
  rooms?: number;
  propertyType?: string;
};

export type TelecomDetails = {
  serviceType?: "mobile" | "home_internet" | "bundle";
  lineCount?: number;
  dataNeed?: string;
  device?: string;
  monthlyBudget?: number;
};

export type StreamingDetails = {
  action?: "search" | "watchlist" | "plan_status" | "manage_plan";
  title?: string;
  genre?: string;
  profile?: string;
  planTier?: string;
};

export type ShoppingDetails = FlightSearchDetails | StaySearchDetails | TelecomDetails | StreamingDetails;

export type ShoppingPauseReason = "captcha" | "two_factor" | "age_verification" | "site_challenge" | "login" | "user_requested";

export interface ShoppingRetailer {
  id: string;
  name: string;
  origin: string;
  countries: string[];
  categories: ShoppingCategory[];
  workflow?: ShoppingWorkflow;
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
  details?: ShoppingDetails;
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
  details?: ShoppingDetails;
}
