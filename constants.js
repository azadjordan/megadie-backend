// Shared enums & UI constants

export const FILTER_FIELD_TYPES = ["enum", "boolean", "range", "text"];
export const FILTER_UI_TYPES    = ["chips", "select", "checkbox", "slider", "search"];

export const PRODUCT_TYPES = [
  "Ribbon",
  "Creasing Matrix",
  "Double Face Tape",
];

/**
 * Each product type can define its own parent group system.
 * Ribbon parent groups = high-level color families.
 */
export const RIBBON_PARENT_GROUPS = [
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
  "Beige/OffWhite/Brown"   // unified neutral group
];

// FUTURE EXAMPLES:
// export const TAPE_PARENT_GROUPS = ["Transparent", "White", "Brown"];
// export const MATRIX_PARENT_GROUPS = ["Yellow", "Blue", "Red"];

// Now stored in the same form you want to show in the UI
export const SIZES = [
  "25 mm", "20 mm", "13 mm",
  "0.4 × 1.5 mm", "0.5 × 1.5 mm", "0.5 × 1.6 mm",
  "6 mm", "9 mm", "10 mm", "12 mm",
];

export const GRADES = ["Premium", "Standard", "Economy"];

export const VARIANTS = [
  "100 Yards",
  "150 Yards",
  "35 Yards",
  "50 Meters",
  "50 Pieces",
];

export const PRICE_RULES = [
  "RIB-GRO-25MM-100YD-PREM",
  "RIB-GRO-25MM-100YD-STD",
  "RIB-GRO-25MM-100YD-ECO",
  "RIB-GRO-13MM-100YD-PREM",
  "RIB-GRO-13MM-100YD-STD",
  "RIB-GRO-13MM-100YD-ECO",
  
  "RIB-SAT-25MM-100YD-PREM",
  "RIB-SAT-25MM-100YD-STD",
  "RIB-SAT-25MM-100YD-ECO",
  "RIB-SAT-13MM-100YD-PREM",
  "RIB-SAT-13MM-100YD-STD",
  "RIB-SAT-13MM-100YD-ECO",
];

// Slot enums unchanged
export const SLOT_STORES = ["ALAIN-MWJ"];
export const SLOT_UNITS = ["A","B","C","D","E","F","G","H","I","J","K","L","M","N"];
export const SLOT_POSITIONS = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16];
