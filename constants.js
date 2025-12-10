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
  "Beige/OffWhite",
  "Brown",

  // Example future global tags
  "Transparent",
  "Opaque",
  "Matte",
  "Glossy",
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

export const SLOT_POSITIONS = [
  1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16
];

/**
 * Ribbon catalog code list
 */
export const ribbonCatalogCodes = [
  "000","007","009","012","017",
  "028","029","030","077","105",
  "112","117","123","141","148",
  "151","156","157","158","168",
  "169","177","182","238","250",
  "260","275","285","305","311",
  "314","323","326","332","338",
  "346","350","365","370","420",
  "434","463","467","510","544",
  "548","550","563","566","570",
  "577","579","587","589","593",
  "600","640","662","675","686",
  "687","690","693","720","751",
  "761","765","777","779","780",
  "812","813","815","823","824",
  "835","838","839","840","846",
  "855","868","869","870"
];
