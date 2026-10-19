import { useEffect, useRef } from 'react';
import { attachModalFocus } from './modal-focus';

export function useModalFocus(onClose: () => void) {
  const dialog = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const node = dialog.current;
    if (node) return attachModalFocus(node, () => close.current());
  }, []);
  return dialog;
}
