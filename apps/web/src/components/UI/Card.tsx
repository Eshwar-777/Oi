import React, { ReactNode } from "react";

export interface ICardProps {
    children: ReactNode;
    className?: string;
}

export const Card: React.FC<ICardProps> = ({ children, className = "" }) => (
    <div className={`bg-white rounded-xl border border-neutral-200 shadow-sm ${className}`}>
        {children}
    </div>
);

export const CardHeader: React.FC<ICardProps> = ({ children, className = "" }) => (
    <div className={`flex items-center justify-between p-4 border-b border-neutral-100 ${className}`}>
        {children}
    </div>
);

export const CardContent: React.FC<ICardProps> = ({ children, className = "" }) => (
    <div className={`p-4 ${className}`}>
        {children}
    </div>
);

export const CardFooter: React.FC<ICardProps> = ({ children, className = "" }) => (
    <div className={`p-4 border-t border-neutral-100 bg-neutral-50/50 rounded-b-xl flex items-center justify-end gap-3 ${className}`}>
        {children}
    </div>
);
