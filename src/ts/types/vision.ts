/**
 * Shapes of the local vision runtime (services/visionVerifier.ts, the
 * platform assets' vision model). Type-only: nothing here exists at runtime.
 */

/** The pinned transformers library the classifier pipeline is built from, as its module namespace. */
export type TransformersModule = typeof import('@huggingface/transformers');
