import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "buy" | "sell" | "danger";
type Size = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

const variants: Record<Variant, string> = {
  primary:
    "bg-accent-subtle text-accent border border-accent/30 hover:bg-accent/20 focus-visible:ring-accent",
  secondary:
    "bg-surface-2 text-text hover:bg-surface-3 border border-border focus-visible:ring-accent",
  ghost: "bg-transparent text-muted hover:text-text hover:bg-surface-2 focus-visible:ring-accent",
  buy: "bg-up-subtle text-up border border-up/40 hover:bg-up/20 focus-visible:ring-up",
  sell: "bg-down-subtle text-down border border-down/40 hover:bg-down/20 focus-visible:ring-down",
  danger: "bg-down-subtle text-down border border-down/40 hover:bg-down/20 focus-visible:ring-down",
};

const sizes: Record<Size, string> = {
  sm: "h-7 px-2.5 text-xs rounded-md",
  md: "h-9 px-3.5 text-sm rounded-lg",
  lg: "h-11 px-5 text-sm rounded-lg",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "primary", size = "md", loading, disabled, children, ...props }, ref) => (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 font-medium transition-colors duration-100 outline-none",
        "focus-visible:ring-2 focus-visible:ring-offset-0",
        "disabled:opacity-50 disabled:pointer-events-none",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    >
      {loading && (
        <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
      )}
      {children}
    </button>
  ),
);
Button.displayName = "Button";
