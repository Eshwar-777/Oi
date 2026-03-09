export function notifyUser(title: string, body: string, route?: string): void {
  if (typeof window === "undefined") return;

  if (window.electronAPI?.showNotification) {
    window.electronAPI.showNotification(title, body, route);
    return;
  }

  if (!("Notification" in window)) return;

  const openRoute = () => {
    if (!route) return;
    window.focus();
    window.location.assign(route);
  };

  if (Notification.permission === "granted") {
    const notification = new Notification(title, { body });
    notification.onclick = () => openRoute();
    return;
  }

  if (Notification.permission === "default") {
    void Notification.requestPermission().then((permission) => {
      if (permission !== "granted") return;
      const notification = new Notification(title, { body });
      notification.onclick = () => openRoute();
    });
  }
}
