"use client";

import { NavigatorFlow } from "../../../components/Navigator/NavigatorFlow";

export default function NavigatorPage() {
  return (
    <div className="flex flex-col h-full bg-white">
      <div className="pt-6 px-4 md:px-8 border-b border-neutral-200">
        <h1 className="text-2xl font-bold text-neutral-900 mb-6">Navigator</h1>
      </div>
      <div className="flex-1 overflow-y-auto p-4 md:p-8 bg-neutral-50/50">
        <NavigatorFlow />
      </div>
    </div>
  );
}

