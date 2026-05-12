import type { ComponentProps, ReactNode } from "react";
import { ChevronRight } from "lucide-react";

import { cn } from "@/shared/lib/utils";

export function Breadcrumb({
  children,
  className,
  ...rest
}: ComponentProps<"nav">) {
  return (
    <nav aria-label="Breadcrumb" className={cn("text-xs text-muted-foreground", className)} {...rest}>
      <ol className="flex items-center flex-wrap gap-x-1 gap-y-0.5">{children}</ol>
    </nav>
  );
}

export function BreadcrumbItem({ children, className, ...rest }: ComponentProps<"li">) {
  return (
    <li className={cn("inline-flex items-center min-w-0", className)} {...rest}>
      {children}
    </li>
  );
}

export function BreadcrumbLink({
  children,
  asChild,
  className,
  ...rest
}: ComponentProps<"a"> & { readonly asChild?: boolean }) {
  if (asChild) {
    return (
      <span className={cn("hover:text-foreground transition-colors truncate", className)}>
        {children}
      </span>
    );
  }
  return (
    <a className={cn("hover:text-foreground transition-colors truncate", className)} {...rest}>
      {children}
    </a>
  );
}

export function BreadcrumbPage({ children, className }: { readonly children: ReactNode; readonly className?: string }) {
  return (
    <span aria-current="page" className={cn("text-foreground font-medium truncate", className)}>
      {children}
    </span>
  );
}

export function BreadcrumbSeparator({ className }: { readonly className?: string }) {
  return (
    <li aria-hidden="true" className={cn("text-muted-foreground/50 shrink-0", className)}>
      <ChevronRight className="size-3" />
    </li>
  );
}
