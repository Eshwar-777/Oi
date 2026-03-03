"use client";

import { useState } from "react";
import { Tabs, ITabItem } from "../../../components/UI/Tabs";
import { CurateFlow } from "../../../components/Tasks/CurateFlow";
import { CompanionFlow } from "../../../components/Tasks/CompanionFlow";
import { ConsultFlow } from "../../../components/Tasks/ConsultFlow";

const TABS: ITabItem[] = [
  { id: "curate", label: "Curate" },
  { id: "companion", label: "Companion" },
  { id: "consult", label: "Consult", count: 1 },
];

export default function TasksPage() {
  const [activeTab, setActiveTab] = useState<string>("companion");

  return (
    <div className="flex flex-col h-full bg-white">
      {/* Header and Tabs */}
      <div className="pt-6 px-4 md:px-8 border-b border-neutral-200">
        <h1 className="text-2xl font-bold text-neutral-900 mb-6">Tasks Hub</h1>
        <Tabs tabs={TABS} activeTabId={activeTab} onChange={setActiveTab} />
      </div>

      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto p-4 md:p-8 bg-neutral-50/50">
        {activeTab === "curate" && <CurateFlow />}
        {activeTab === "companion" && <CompanionFlow />}
        {activeTab === "consult" && <ConsultFlow />}
      </div>
    </div>
  );
}

