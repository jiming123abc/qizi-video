import { useEffect, useCallback } from 'react';

/**
 * Hook to handle Escape key press
 * @param onEscape - Callback function to execute when Escape is pressed
 * @param enabled - Whether the hook is enabled (default: true)
 */
export function useEscapeKey(onEscape: () => void, enabled: boolean = true) {
  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.key === 'Escape' && enabled) {
      onEscape();
    }
  }, [onEscape, enabled]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleKeyDown]);
}
