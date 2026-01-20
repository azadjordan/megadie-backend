# User schema differences (main → develop)

## Main branch schema (baseline)
- Fields: `name`, `email`, `password`, `isAdmin`, `phoneNumber`, `address`.
- All required fields: `name`, `email`, `password`, `isAdmin`.
- `phoneNumber` and `address` are optional.
- No approval status workflow fields.
- No password reset token fields.
- No additional indexes beyond the `email` uniqueness index.

## Develop branch schema changes
- `phoneNumber` is required on create (still optional for existing documents via `isNew`).
- Added approval workflow fields:
  - `approvalStatus` (enum: `Pending`, `Approved`, `Rejected`, default `Pending`, indexed).
  - `approvedAt`, `approvedBy`, `rejectedAt`, `rejectedBy`.
- Added password reset fields:
  - `passwordResetTokenHash`, `passwordResetExpires`.
- Added index on `name`.
- Response serialization now removes `passwordResetTokenHash` and `passwordResetExpires`.
