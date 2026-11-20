"use client";

/** Full-screen state shown when the case list cannot be reached any more. */
export function ConnectionLost() {
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3.5 bg-aida-bg">
      <h1 className="text-[26px] font-bold text-aida-text">
        Cannot reach the app
      </h1>
      <p className="text-sm text-aida-muted">
        The local system is not running. Start it, then reload this page. Cases
        in progress continue where they stopped.
      </p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="mt-1 rounded-[10px] bg-aida-primary px-[18px] py-2.5 text-[13px] font-medium text-white hover:brightness-110"
      >
        Reload
      </button>
    </div>
  );
}
