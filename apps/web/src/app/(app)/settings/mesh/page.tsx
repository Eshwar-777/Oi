"use client";

import Link from "next/link";

export default function MeshPage() {
  return (
    <div className="p-6 max-w-2xl">
      <Link
        href="/settings"
        className="text-sm text-maroon-500 hover:underline mb-4 inline-block"
      >
        &larr; Back to Settings
      </Link>

      <div className="flex items-center justify-between mb-6">
        <h1 className="text-lg font-semibold text-neutral-900">Mesh Groups</h1>
        <button className="bg-maroon-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-maroon-600 transition-colors">
          Create Group
        </button>
      </div>

      <div className="bg-white rounded-xl border border-neutral-200 p-8 text-center">
        <p className="text-sm text-neutral-500 mb-4">
          Create a mesh group to share tasks with family or colleagues.
          Anyone in the group can respond when OI needs a human.
        </p>
        <p className="text-xs text-neutral-400">
          Each member needs the OI app on at least one device.
        </p>
      </div>
    </div>
  );
}
