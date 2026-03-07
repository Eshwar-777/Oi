import React, { ReactNode } from "react";

export interface IEmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

export const EmptyState: React.FC<IEmptyStateProps> = ({
  icon,
  title,
  description,
  action,
  className = "",
}) => (
  <div
    className={`flex flex-col items-center justify-center py-16 px-6 text-center ${className}`}
  >
    {icon && (
      <div className="w-16 h-16 rounded-2xl bg-neutral-100 flex items-center justify-center text-2xl mb-4">
        {icon}
      </div>
    )}
    <h3 className="text-base font-semibold text-neutral-700 mb-1">{title}</h3>
    {description && (
      <p className="text-sm text-neutral-500 max-w-sm mb-6">{description}</p>
    )}
    {action}
  </div>
);
