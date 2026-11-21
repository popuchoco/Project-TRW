export interface StatusElement {
  textContent: string | null;
  hidden: boolean;
}

export function createStatusController(el: StatusElement): {
  show(message: string): void;
  showSticky(message: string): void;
  hide(): void;
  getStickyMessage(): string | undefined;
} {
  let stickyMessage: string | undefined;

  const show = (message: string): void => {
    el.textContent = message;
    el.hidden = false;
  };

  return {
    show,
    showSticky: (message) => {
      stickyMessage = message;
      show(message);
    },
    hide: () => {
      if (stickyMessage) show(stickyMessage);
      else el.hidden = true;
    },
    getStickyMessage: () => stickyMessage,
  };
}
