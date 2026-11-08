/**
 * Brings outside changes into a form that may have unapplied edits: every field that changed from
 * `previous` to `next` takes its new value, and every other field keeps what the user typed.
 */
export function rebaseEdits<T extends object>(edited: T, previous: T, next: T): T {
    const result = { ...edited };
    const keys = new Set([...Object.keys(previous), ...Object.keys(next)]) as Set<keyof T>;
    keys.forEach(key => {
        if (next[key] !== previous[key]) {
            result[key] = next[key];
        }
    });
    return result;
}
