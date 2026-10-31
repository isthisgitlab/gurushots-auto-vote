/**
 * The Capacitor runtime's presence, shared by the Capacitor shell's modules.
 * Dependency-free: the only import is the globals' type.
 */

import type { CapacitorGlobals } from '../types/capacitor';

/**
 * The Capacitor runtime's presence — the global is here and its platform
 * probe is a function. The probe is not called, so a Capacitor web target —
 * where the probe exists and answers false — counts as present, exactly as
 * the runtime.isCapacitor() check this replaced did.
 */
const isCapacitorNative = () => {
    const cap = (globalThis as CapacitorGlobals).Capacitor;
    return cap != null && typeof cap.isNativePlatform === 'function';
};

export { isCapacitorNative };
