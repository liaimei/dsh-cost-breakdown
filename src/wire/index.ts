/**
 * The wire layer's public face.
 *
 * Consumers import from here rather than from the individual modules so that the projection-key
 * augmentation (which lives in `augment.ts` and is installed by being imported) can never be
 * forgotten: one import of this barrel is enough for `register` and `useProjection` to type-check.
 */

export * from './model'
export * from './schema'
// Type-only side effect: installs the module augmentation for the three projection keys.
export type {} from './augment'
