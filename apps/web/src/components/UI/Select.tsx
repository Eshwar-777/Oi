import React from "react";

export interface ISelectOption {
  value: string;
  label: string;
  description?: string;
}

export interface ISelectProps {
  options: ISelectOption[];
  value: string;
  onChange: (value: string) => void;
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

export const Select: React.FC<ISelectProps> = ({
  options,
  value,
  onChange,
  label,
  placeholder = "Select...",
  disabled = false,
  className = "",
}) => (
  <div className={`space-y-1.5 ${className}`}>
    {label && (
      <label className="text-sm font-semibold text-neutral-700">{label}</label>
    )}
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="w-full appearance-none px-4 py-2.5 pr-10 rounded-lg border border-neutral-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-maroon-500 focus:border-maroon-500 disabled:opacity-50 disabled:bg-neutral-50 transition-colors"
      >
        {placeholder && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3">
        <svg
          className="w-4 h-4 text-neutral-400"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </div>
    </div>
  </div>
);
