import * as React from 'react';
import { cva } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-muted text-foreground',
        outline: 'border-border text-foreground',
        success: 'border-[rgba(61,122,94,0.25)] bg-[rgba(61,122,94,0.10)] text-[var(--primary)]',
        info: 'border-[rgba(196,168,67,0.25)] bg-[rgba(196,168,67,0.10)] text-[#8f7c35]',
        warning: 'border-[rgba(181,74,68,0.25)] bg-[rgba(181,74,68,0.10)] text-[var(--destructive)]',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

function Badge({ className, variant, ...props }) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
