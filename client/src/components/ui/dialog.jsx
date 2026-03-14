import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cn } from '../../lib/utils';

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn('fixed inset-0 z-50 bg-black/55 backdrop-blur-[2px]', className)}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef(({ className, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        'fixed left-1/2 top-1/2 z-50 grid w-[calc(100vw-1.5rem)] max-w-5xl -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl border border-border bg-card p-0 shadow-soft',
        className
      )}
      {...props}
    />
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({ className, ...props }) => (
  <div className={cn('flex items-center justify-between gap-3 border-b border-border px-6 py-4', className)} {...props} />
);

const DialogTitle = React.forwardRef(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn('text-lg font-semibold text-foreground', className)} {...props} />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogBody = ({ className, ...props }) => (
  <div className={cn('max-h-[calc(100vh-7rem)] overflow-y-auto px-6 py-5', className)} {...props} />
);

export { Dialog, DialogTrigger, DialogClose, DialogContent, DialogHeader, DialogTitle, DialogBody };
