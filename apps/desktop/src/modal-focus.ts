export function attachModalFocus(node: HTMLElement, onClose: () => void) {
  const previous = document.activeElement;
  node.focus();
  const keydown = (event: KeyboardEvent) => {
    if (event.isComposing || event.defaultPrevented) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === 'Tab') {
      const controls = Array.from(
        node.querySelectorAll<HTMLElement>(
          'button, input, select, textarea, summary, a[href], [tabindex]',
        ),
      ).filter(
        item =>
          item.tabIndex >= 0 &&
          !item.matches(':disabled') &&
          item.getClientRects().length > 0 &&
          getComputedStyle(item).visibility !== 'hidden',
      );
      const first = controls[0],
        last = controls.at(-1);
      const active = document.activeElement;
      if (!first) {
        event.preventDefault();
        node.focus();
      } else if (!controls.includes(active as HTMLElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };
  node.addEventListener('keydown', keydown);
  return () => {
    node.removeEventListener('keydown', keydown);
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
  };
}
