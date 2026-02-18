import { useEffect, useCallback } from 'react';

type Modifier = 'cmd' | 'ctrl' | 'shift' | 'alt';

interface KeyboardShortcutOptions {
  modifiers?: Modifier[];
  ignoreInputs?: boolean;
  enabled?: boolean;
}

function isInputElement(element: EventTarget | null): boolean {
  if (!element || !(element instanceof HTMLElement)) return false;
  const tagName = element.tagName.toLowerCase();
  return (
    tagName === 'input' ||
    tagName === 'textarea' ||
    tagName === 'select' ||
    element.isContentEditable
  );
}

function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);
}

export function useKeyboardShortcut(
  key: string,
  callback: () => void,
  options: KeyboardShortcutOptions = {},
) {
  const { modifiers = [], ignoreInputs = true, enabled = true } = options;

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!enabled) return;

      if (ignoreInputs && isInputElement(event.target)) return;

      const pressedKey = event.key.toLowerCase();
      const targetKey = key.toLowerCase();

      if (pressedKey !== targetKey) return;

      const hasCmd = modifiers.includes('cmd');
      const hasCtrl = modifiers.includes('ctrl');
      const hasShift = modifiers.includes('shift');
      const hasAlt = modifiers.includes('alt');

      const cmdOrCtrlPressed = isMac() ? event.metaKey : event.ctrlKey;
      const cmdOrCtrlRequired = hasCmd || hasCtrl;

      if (cmdOrCtrlRequired && !cmdOrCtrlPressed) return;
      if (!cmdOrCtrlRequired && cmdOrCtrlPressed) return;

      if (hasShift && !event.shiftKey) return;
      if (!hasShift && event.shiftKey) return;

      if (hasAlt && !event.altKey) return;
      if (!hasAlt && event.altKey) return;

      event.preventDefault();
      callback();
    },
    [key, callback, modifiers, ignoreInputs, enabled],
  );

  useEffect(() => {
    if (!enabled) return;

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleKeyDown, enabled]);
}

export function getModifierKey(): string {
  return isMac() ? '⌘' : 'Ctrl';
}
