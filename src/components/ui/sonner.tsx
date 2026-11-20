"use client";

import { Toaster as Sonner, type ToasterProps } from "sonner";

/** Toasts in the design: a dark card with a coloured left edge for its state. */
function Toaster(props: ToasterProps) {
  return (
    <Sonner
      theme="dark"
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast:
            "!rounded-xl !border !border-aida-input-line !bg-aida-surface !text-aida-text !shadow-2xl !border-l-[3px] !px-4 !py-3.5",
          title: "!text-sm !font-semibold !text-aida-text",
          description: "!text-[13px] !text-aida-muted",
          actionButton: "!bg-aida-primary !text-white",
          cancelButton: "!bg-aida-nav-active !text-aida-text-2",
          error: "!border-l-aida-red",
          success: "!border-l-aida-green-dot",
          warning: "!border-l-aida-amber",
          info: "!border-l-aida-primary",
        },
      }}
      {...props}
    />
  );
}

export { Toaster };
