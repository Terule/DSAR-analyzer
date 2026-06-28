import { AlertCircle, CheckCircle, Info } from "lucide-react";
import type { AppNotification } from "@/lib/types";

export function NotificationToast({
  notification,
}: {
  notification: AppNotification;
}) {
  return (
    <div
      className={`fixed top-4 right-4 z-50 p-4 rounded-xl shadow-2xl border flex items-center gap-3 w-96 animate-in slide-in-from-top-4 ${
        notification.type === "error"
          ? "bg-rose-900/90 border-rose-500 text-white"
          : notification.type === "success"
            ? "bg-emerald-900/90 border-emerald-500 text-white"
            : "bg-blue-900/90 border-blue-500 text-white"
      }`}
    >
      {notification.type === "error" ? (
        <AlertCircle className="w-5 h-5" />
      ) : notification.type === "success" ? (
        <CheckCircle className="w-5 h-5" />
      ) : (
        <Info className="w-5 h-5" />
      )}
      <p className="text-sm font-semibold">{notification.message}</p>
    </div>
  );
}
