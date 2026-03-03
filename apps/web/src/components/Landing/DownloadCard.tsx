import React from "react";

export interface IDownloadCardProps {
    platform: string;
    description: string;
}

export const DownloadCard: React.FC<IDownloadCardProps> = ({ platform, description }) => {
    return (
        <div className="border border-neutral-200 rounded-xl p-6 hover:border-maroon-300 hover:shadow-md transition-all cursor-pointer">
            <div className="text-lg font-semibold text-neutral-900">{platform}</div>
            <div className="text-sm text-neutral-500 mt-1">{description}</div>
            <div className="mt-4 text-sm font-medium text-maroon-500">Download &rarr;</div>
        </div>
    );
};
