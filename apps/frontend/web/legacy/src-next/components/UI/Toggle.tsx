import React from "react";

export interface IToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  description?: string;
  disabled?: boolean;
  size?: "sm" | "md";
}

export const Toggle: React.FC<IToggleProps> = ({
  checked,
  onChange,
  label,
  description,
  disabled = false,
  size = "md",
}) => {
  const trackSize = size === "sm" ? "w-8 h-[18px]" : "w-11 h-6";
  const thumbSize = size === "sm" ? "w-3.5 h-3.5" : "w-5 h-5";
  const thumbTranslate = size === "sm" ? "translate-x-[14px]" : "translate-x-5";

  return (
    <label
      className={`flex items-center gap-3 ${
        disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
      }`}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={`relative inline-flex shrink-0 ${trackSize} rounded-full transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-maroon-500 focus:ring-offset-2 ${
          checked ? "bg-maroon-600" : "bg-neutral-300"
        }`}
      >
        <span
          className={`pointer-events-none inline-block ${thumbSize} rounded-full bg-white shadow-sm ring-0 transition-transform duration-200 ease-in-out ${
            checked ? thumbTranslate : "translate-x-0.5"
          } ${size === "sm" ? "mt-[2px]" : "mt-0.5"}`}
        />
      </button>
      {(label || description) && (
        <div className="flex flex-col">
          {label && (
            <span className="text-sm font-medium text-neutral-700">
              {label}
            </span>
          )}
          {description && (
            <span className="text-xs text-neutral-500">{description}</span>
          )}
        </div>
      )}
    </label>
  );
};
