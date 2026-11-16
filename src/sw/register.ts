export function registerServiceWorker(onUpdateAvailable: (activateUpdate: () => void) => void): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;

  let reloadAfterControllerChange = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloadAfterControllerChange) window.location.reload();
  });

  void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, {
    scope: import.meta.env.BASE_URL,
  }).then((registration) => {
    const offerUpdate = (worker: ServiceWorker): void => {
      onUpdateAvailable(() => {
        reloadAfterControllerChange = true;
        worker.postMessage({ type: "SKIP_WAITING" });
      });
    };

    if (registration.waiting && navigator.serviceWorker.controller) offerUpdate(registration.waiting);
    registration.addEventListener("updatefound", () => {
      const installing = registration.installing;
      if (!installing) return;
      installing.addEventListener("statechange", () => {
        if (installing.state === "installed" && navigator.serviceWorker.controller) offerUpdate(installing);
      });
    });
  }).catch((error: unknown) => {
    console.info("Service worker registration failed.", error);
  });
}
