"use client";

import { useParams } from "next/navigation";
import Link from "next/link";

export default function TaskDetailPage() {
  const params = useParams();
  const taskId = params.id as string;

  /* In production, subscribe to Firestore real-time updates for this task.
     Display the plan steps, current progress, timeline events,
     and the action-needed UI when status is 'blocked'. */

  return (
    <div className="p-6 max-w-3xl">
      <Link
        href="/tasks"
        className="text-sm text-maroon-500 hover:underline mb-4 inline-block"
      >
        &larr; Back to Tasks
      </Link>

      <div className="bg-white rounded-xl border border-neutral-200 p-6">
        <h1 className="text-lg font-semibold text-neutral-900 mb-2">Task Detail</h1>
        <p className="text-sm text-neutral-500 mb-6">Task ID: {taskId}</p>

        {/* Plan Steps */}
        <div className="space-y-3 mb-8">
          <h2 className="text-sm font-semibold text-neutral-700">Plan Steps</h2>
          <div className="text-sm text-neutral-400 italic">
            Task details will appear here when connected to the backend.
          </div>
        </div>

        {/* Action Needed (shown when task is blocked) */}
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <h2 className="text-sm font-semibold text-red-700 mb-2">Action Needed</h2>
          <p className="text-sm text-red-600 mb-3">
            This area appears when OI encounters something it cannot handle
            automatically (e.g., a CAPTCHA or a decision that requires your input).
          </p>
          <button className="bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-700 transition-colors">
            Take Action
          </button>
        </div>
      </div>
    </div>
  );
}
