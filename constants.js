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
 "0.4 x 1.5 - 11mm", "0.4 x 1.5 - 12mm", "0.5 × 1.6 - 11mm",
  "6 mm", "9 mm", "10 mm", "12 mm",
];

export const GRADES = [
  "A",
  "A+",
  "B",
  "B-",
  ];

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
  "Plastic Core",
  "Paper Core",

];

export const PACKING_UNITS = [
  "100yd Roll",
  "35yd Roll",
  "150yd Bundle",
  "48pc Pack",
  "50pc Pack",
  "50m Roll",
];

// SKU short tokens for enum-like fields (others are sanitized directly)
export const SKU_TOKENS = {
  productType: {
    Ribbon: "RIB",
    "Creasing Matrix": "CRM",
    "Double Face Tape": "DFT",
  },
  categoryKey: {
    grosgrain: "GRO",
    satin: "SAT",
    acrylic: "ACR",
    paper: "PAP",
    pro: "PRO",
    plus: "PLUS",
  },
  size: {
    "25 mm": "25-MM",
    "20 mm": "20-MM",
    "13 mm": "13-MM",
    "0.4 x 1.5 - 11mm": "04X15X11MM",
    "0.4 x 1.5 - 12mm": "04X15X12MM",
    "0.4 x 1.5 - 9mm": "04X15X9MM",
    "0.5 x 1.6 - 11mm": "05X16X11MM",
    "6 mm": "6-MM",
    "9 mm": "9-MM",
    "10 mm": "10-MM",
    "12 mm": "12-MM",
  },
  grade: {
    A: "A",
    "A+": "A+",
    B: "B",
    "B-": "B-",
  },
  variant: {
    "Plastic Core": "PLC",
    "Paper Core": "PPC",
  },
  finish: {
    "Single Face": "SF",
    "Double Face": "DF",
  },
  packingUnit: {
    "100yd Roll": "100YD-ROLL",
    "35yd Roll": "35YD-ROLL",
    "150yd Bundle": "150YD-BUNDLE",
    "48pc Pack": "48PC-PACK",
    "50pc Pack": "50PC-PACK",
    "50m Roll": "50M-ROLL",
  },
};


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
  "434","463","465","467","510",
  "544","548","550","563","566",
  "567","570","577","579","587",
  "589","593","600","640","662",
  "675","686","687","690","693",
  "720","751","761","765","777",
  "779","780","812","813","815",
  "820","823","824","835","838",
  "839","840","846","847","855",
  "868","869","870"
];

