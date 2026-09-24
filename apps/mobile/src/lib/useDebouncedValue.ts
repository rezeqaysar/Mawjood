import { useEffect, useState } from 'react';

/**
 * Generic debounce: returns `value` delayed by `delayMs` after it stops
 * changing. Used by every tab's search so we never query per keystroke.
 */
export function useDebouncedValue<T>(value: T, delayMs = 400): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}
