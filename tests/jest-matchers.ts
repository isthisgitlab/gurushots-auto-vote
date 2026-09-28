/**
 * @types/jest types the asymmetric matchers (expect.any, objectContaining, …)
 * as returning `any`, which then leaks into every expected value that embeds
 * one. These overloads merge ahead of the originals and return the
 * AsymmetricMatcher each one really is.
 */
declare global {
    namespace jest {
        interface Expect {
            anything(): AsymmetricMatcher;
            any(classType: unknown): AsymmetricMatcher;
            arrayContaining<E = unknown>(arr: readonly E[]): AsymmetricMatcher;
            closeTo(num: number, numDigits?: number): AsymmetricMatcher;
            objectContaining<E = object>(obj: E): AsymmetricMatcher;
            stringMatching(str: string | RegExp): AsymmetricMatcher;
            stringContaining(str: string): AsymmetricMatcher;
        }
        interface InverseAsymmetricMatchers {
            arrayContaining<E = unknown>(arr: readonly E[]): AsymmetricMatcher;
            objectContaining<E = object>(obj: E): AsymmetricMatcher;
            stringMatching(str: string | RegExp): AsymmetricMatcher;
            stringContaining(str: string): AsymmetricMatcher;
        }
    }
}

export {};
