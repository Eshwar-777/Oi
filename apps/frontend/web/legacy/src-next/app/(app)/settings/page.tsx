"use client";

import Link from "next/link";

export default function SettingsPage() {
  return (
    <div className="p-6 max-w-2xl">
      <h1 className="text-lg font-semibold text-neutral-900 mb-6">Settings</h1>

      <div className="space-y-4">
        <Link
          href="/settings/devices"
          className="block bg-white rounded-xl border border-neutral-200 p-5 hover:border-maroon-300 transition-colors"
        >
          <div className="text-base font-medium text-neutral-900">Devices</div>
          <p className="text-sm text-neutral-500 mt-1">
            Manage your registered devices and notification preferences.
          </p>
        </Link>

        <Link
          href="/settings/mesh"
          className="block bg-white rounded-xl border border-neutral-200 p-5 hover:border-maroon-300 transition-colors"
        >
          <div className="text-base font-medium text-neutral-900">Mesh Groups</div>
          <p className="text-sm text-neutral-500 mt-1">
            Create groups with family or friends who can help when OI needs a human.
          </p>
        </Link>

        <div className="bg-white rounded-xl border border-neutral-200 p-5">
          <div className="text-base font-medium text-neutral-900">Account</div>
          <p className="text-sm text-neutral-500 mt-1">
            Manage your account, email, and sign-out.
          </p>
        </div>
      </div>
    </div>
  );
}
