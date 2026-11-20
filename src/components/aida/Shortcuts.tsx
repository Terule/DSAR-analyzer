"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Btn, Modal } from "./ui";

const LIST: Array<[string, string]> = [
  ["Go to Cases", "G then C"],
  ["Go to History", "G then H"],
  ["Go to Settings", "G then S"],
  ["New case", "N"],
  ["Search", "/"],
  ["Export CSV in a panel", "E"],
  ["Close panel or dialog", "Esc"],
  ["Show this list", "?"],
];

function typing(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

/** Global keyboard shortcuts and the list that explains them. */
export function Shortcuts() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let leader = 0;
    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      )
        return;
      if (typing(event.target)) return;
      const key = event.key.toLowerCase();
      if (leader && Date.now() - leader < 1_200) {
        leader = 0;
        const target = { c: "/", h: "/history", s: "/settings" }[key];
        if (target) {
          event.preventDefault();
          router.push(target);
          return;
        }
      }
      if (key === "g") {
        leader = Date.now();
      } else if (key === "n") {
        event.preventDefault();
        if (window.location.pathname === "/")
          window.dispatchEvent(new Event("aida:new-case"));
        else router.push("/?new=1");
      } else if (key === "/") {
        const input = document.querySelector<HTMLInputElement>(
          'input[aria-label^="Search"]',
        );
        if (input) {
          event.preventDefault();
          input.focus();
        }
      } else if (key === "e") {
        window.dispatchEvent(new Event("aida:export"));
      } else if (event.key === "?") {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);
  return (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      title="Keyboard shortcuts"
      width={460}
      footer={
        <Btn kind="soft" onClick={() => setOpen(false)}>
          Close
        </Btn>
      }
    >
      <div className="divide-y divide-aida-line">
        {LIST.map(([label, keys]) => (
          <div
            key={label}
            className="flex items-center justify-between py-3 text-sm"
          >
            <span className="text-aida-text-2">{label}</span>
            <kbd className="rounded-md border border-aida-input-line bg-aida-sidebar px-2 py-1 font-sans text-xs text-aida-text-3">
              {keys}
            </kbd>
          </div>
        ))}
      </div>
    </Modal>
  );
}
