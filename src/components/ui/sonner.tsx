"use client";

import { Toaster as Sonner, type ToasterProps } from "sonner";

function Toaster(props: ToasterProps) {
  return (
    <Sonner
      theme="dark"
      position="top-right"
      toastOptions={{
        classNames: {
          toast:
            "border border-slate-600 bg-slate-800 text-slate-100 shadow-2xl",
          title: "font-semibold",
          description: "text-slate-400",
          actionButton: "bg-indigo-600 text-white",
          cancelButton: "bg-slate-700 text-slate-100",
          error: "border-rose-500/60 bg-rose-950 text-rose-100",
          success: "border-emerald-500/60 bg-emerald-950 text-emerald-100",
          info: "border-indigo-500/60 bg-slate-900 text-slate-100",
        },
      }}
      {...props}
    />
  );
}

export { Toaster };
