import React from "react";

export type BadgeVariant = "default" | "success" | "warning" | "error" | "info" | "neutral";

export interface IBadgeProps {
    children: React.ReactNode;
    variant?: BadgeVariant;
    className?: string;
    icon?: React.ReactNode;
}

const variantStyles: Record<BadgeVariant, string> = {
    default: "bg-maroon-50 text-maroon-700",
    success: "bg-green-100 text-green-700",
    warning: "bg-yellow-100 text-yellow-700", // Adjusted for typical warning instead of orange
    error: "bg-red-100 text-red-700",
    info: "bg-blue-100 text-blue-700",
    neutral: "bg-neutral-100 text-neutral-600",
};

export const Badge: React.FC<IBadgeProps> = ({
    children,
    variant = "default",
    className = "",
    icon,
}) => {
    return (
        <span
            className={`inline-flex items-center justify-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold ${variantStyles[variant]} ${className}`}
        >
            {icon && <span className="flex-shrink-0 flex">{icon}</span>}
            {children}
        </span>
    );
};
