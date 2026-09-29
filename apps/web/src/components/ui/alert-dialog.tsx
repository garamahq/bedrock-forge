import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface AlertDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  confirmText?: string;
  confirmVariant?: "default" | "destructive";
  onConfirm: () => void;
  isPending?: boolean;
  confirmDisabled?: boolean;
  requireTextConfirm?: string;
  children?: React.ReactNode;
}

/**
 * Lightweight alert/confirm dialog built atop the base Dialog primitive.
 * No @radix-ui/react-alert-dialog dependency required.
 */
export function AlertDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  confirmText,
  confirmVariant = "destructive",
  onConfirm,
  isPending = false,
  confirmDisabled = false,
  requireTextConfirm,
  children,
}: AlertDialogProps) {
  const [typedText, setTypedText] = React.useState("");

  React.useEffect(() => {
    if (!open) {
      setTypedText("");
    }
  }, [open]);

  const isDisabled =
    isPending ||
    confirmDisabled ||
    (!!requireTextConfirm && typedText !== requireTextConfirm);
  const buttonLabel = confirmLabel || confirmText || "Confirm";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="space-y-4 pt-2">
            <div>{description}</div>
            {requireTextConfirm && (
              <div className="space-y-2 pt-3 border-t border-border/50">
                <p className="text-xs text-muted-foreground">
                  To confirm deletion, type{" "}
                  <span className="font-mono font-semibold text-foreground select-all bg-muted px-1.5 py-0.5 rounded border">
                    {requireTextConfirm}
                  </span>{" "}
                  below:
                </p>
                <Input
                  value={typedText}
                  onChange={(e) => setTypedText(e.target.value)}
                  placeholder={requireTextConfirm}
                  className="font-mono text-sm h-9"
                  disabled={isPending}
                />
              </div>
            )}
          </DialogDescription>
        </DialogHeader>
        {children}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button
            variant={confirmVariant}
            onClick={onConfirm}
            disabled={isDisabled}
          >
            {isPending ? "Processing…" : buttonLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
