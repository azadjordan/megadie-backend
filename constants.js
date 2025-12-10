// Shared enums & UI constants

export const FILTER_FIELD_TYPES = ["enum", "boolean", "range", "text"];
export const FILTER_UI_TYPES    = ["chips", "select", "checkbox", "slider", "search"];

export const PRODUCT_TYPES = [
  "Ribbon",
  "Creasing Matrix",
  "Double Face Tape",
];

/**
 * GLOBAL TAG ENUMS
 * Used by all product types.
 * Ribbon color families are now just part of the global tag set.
 */
export const TAGS = [
  // Ribbon color groups
  "Red",
  "Pink",
  "Orange",
  "Yellow",
  "Green",
  "Blue",
  "Purple",
  "Grey",
  "Black",
  "White",
  "Beige/OffWhite/Brown",

  // Example future global tags
  "Transparent",
  "Opaque",
  "Matte",
  "Glossy",

  // Add anytime:
  // "Heavy Duty",
  // "Light Duty",
  // "Industrial",
];

/**
 * Sizes shared across products
 */
export const SIZES = [
  "25 mm", "20 mm", "13 mm",
  "0.4 × 1.5 mm", "0.5 × 1.5 mm", "0.5 × 1.6 mm",
  "6 mm", "9 mm", "10 mm", "12 mm",
];

export const GRADES = ["Premium", "Standard", "Economy"];

/**
 * Generic finish / construction axis:
 * - For ribbons: "Single Face", "Double Face"
 * - For other product types: Matte, Glossy, Embossed, etc.
 */
export const FINISHES = [
  "Single Face",
  "Double Face",
  // Future-proofing:
  // "Matte",
  // "Glossy",
  // "Embossed",
];

export const VARIANTS = [
  "100 Yards",
  "150 Yards",
  "35 Yards",
  "50 Meters",
  "50 Pieces",
];

export const PRICE_RULES = [
  "RIB-GRO-25MM-100YD-PREM-ROLL",
  "RIB-GRO-13MM-100YD-PREM-ROLL",
  "RIB-SAT-25MM-100YD-SF-PREM-ROLL",
  "RIB-SAT-13MM-100YD-SF-PREM-ROLL",
];

/** 
 * SLOT SYSTEM 
 * Stores → AE1 / AE2
 * Units include FLOOR
 */
export const SLOT_STORES = ["AE1", "AE2"];

export const SLOT_UNITS = [
  "A","B","C","D","E","F","G","H","I","J","K","L","M","N",
  "FLOOR", // ← NEW
];

export const SLOT_POSITIONS = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16];
