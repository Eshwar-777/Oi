import React from "react";

export interface ITabItem {
    id: string;
    label: string;
    count?: number;
}

export interface ITabsProps {
    tabs: ITabItem[];
    activeTabId: string;
    onChange: (id: string) => void;
    className?: string;
}

export const Tabs: React.FC<ITabsProps> = ({
    tabs,
    activeTabId,
    onChange,
    className = "",
}) => {
    return (
        <div className={`flex items-center gap-6 border-b border-neutral-200 overflow-x-auto hide-scrollbar ${className}`}>
            {tabs.map((tab) => {
                const isActive = tab.id === activeTabId;
                return (
                    <button
                        key={tab.id}
                        onClick={() => onChange(tab.id)}
                        className={`relative py-3 px-1 text-sm font-medium transition-colors hover:text-maroon-600 flex items-center gap-2 whitespace-nowrap ${isActive ? "text-maroon-600" : "text-neutral-500"
                            }`}
                    >
                        {tab.label}
                        {tab.count !== undefined && (
                            <span
                                className={`flex items-center justify-center px-1.5 min-w-[20px] h-[20px] text-[11px] font-bold rounded-full ${isActive
                                        ? "bg-maroon-100 text-maroon-700"
                                        : "bg-neutral-100 text-neutral-500"
                                    }`}
                            >
                                {tab.count}
                            </span>
                        )}
                        {isActive && (
                            <span className="absolute bottom-0 left-0 right-0 border-b-2 border-maroon-600 rounded-t" />
                        )}
                    </button>
                );
            })}
        </div>
    );
};
