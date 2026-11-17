import { VARIANTS } from '../constants.js';

export const variantsByProductType = { 'Double Face Tape': ['Plastic Core'] };
export const allowedProductVariants = productType => variantsByProductType[productType] || VARIANTS;
export const isAllowedProductVariant = (productType, variant) => !variant || allowedProductVariants(productType).includes(variant);
export const tapeVariantMessage = 'Paper Core double-face tape is discontinued. Choose Plastic Core.';
