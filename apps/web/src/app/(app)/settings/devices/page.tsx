"use client";

import Link from "next/link";

export default function DevicesPage() {
  return (
    <div className="p-6 max-w-2xl">
      <Link
        href="/settings"
        className="text-sm text-maroon-500 hover:underline mb-4 inline-block"
      >
        &larr; Back to Settings
      </Link>

      <h1 className="text-lg font-semibold text-neutral-900 mb-6">Your Devices</h1>

      <div className="bg-white rounded-xl border border-neutral-200 divide-y divide-neutral-100">
        <div className="p-4 flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-neutral-900">This Browser</div>
            <div className="text-xs text-neutral-400">Web &middot; Online now</div>
          </div>
          <span className="w-2 h-2 rounded-full bg-green-500" />
        </div>

        <div className="p-4 text-sm text-neutral-400 text-center">
          Other devices will appear here when you sign in on them.
        </div>
      </div>
    </div>
  );
}
