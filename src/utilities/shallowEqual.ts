/**
 * True when both objects have the same keys with identical values (`Object.is`, so that
 * NaN equals NaN). Nested objects and arrays are compared by reference.
 */
export function shallowEqual<T extends object>(a: T, b: T): boolean {
    const keysA = Object.keys(a) as Array<keyof T>;
    const keysB = Object.keys(b) as Array<keyof T>;
    return keysA.length === keysB.length && keysA.every(key => Object.is(a[key], b[key]));
}
