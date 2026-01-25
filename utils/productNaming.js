import { SKU_TOKENS } from "../constants.js";

export const sanitizeToken = (value) => {
  if (!value) return "";
  return String(value)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9./]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
};

export const skuToken = (field, value, skuTokens = SKU_TOKENS) => {
  if (!value) return "";
  const map = skuTokens?.[field];
  const mapped = map?.[value];
  if (mapped) return mapped;
  return sanitizeToken(value);
};

export const buildSku = (
  {
    productType,
    categoryKey,
    size,
    color,
    catalogCode,
    variant,
    grade,
    finish,
    packingUnit,
  },
  skuTokens = SKU_TOKENS
) => {
  const parts = [
    skuToken("productType", productType, skuTokens),
    skuToken("categoryKey", categoryKey, skuTokens),
    skuToken("size", size, skuTokens),
    sanitizeToken(color),
    sanitizeToken(catalogCode),
    skuToken("variant", variant, skuTokens),
    skuToken("grade", grade, skuTokens),
    skuToken("finish", finish, skuTokens),
    skuToken("packingUnit", packingUnit, skuTokens),
  ].filter(Boolean);

  return parts.join("|") || "SKU";
};

export const buildName = ({
  productType,
  categoryLabel,
  size,
  color,
  finish,
  packingUnit,
  grade,
}) => {
  const sizeLabel = size ? `(${size})` : "";
  const gradeLabel = grade ? `[${grade}]` : "";
  const parts = [
    productType,
    categoryLabel,
    sizeLabel,
    color,
    finish,
    packingUnit,
    gradeLabel,
  ].filter(Boolean);
  return parts.join(" ");
};
