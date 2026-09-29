const SCROLL_IDLE_DELAY = 700;

export function createScrollAffordance() {
  function bind(element) {
    if (!element) return () => {};

    let idleTimer = null;

    function onScroll() {
      element.classList.add('is-scrolling');
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        element.classList.remove('is-scrolling');
        idleTimer = null;
      }, SCROLL_IDLE_DELAY);
    }

    element.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      element.removeEventListener('scroll', onScroll);
      if (idleTimer) clearTimeout(idleTimer);
      element.classList.remove('is-scrolling');
    };
  }

  return { bind };
}
