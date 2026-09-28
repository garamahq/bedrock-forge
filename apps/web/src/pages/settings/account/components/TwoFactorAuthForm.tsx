import React, { useState } from "react";
import { ShieldCheck, ShieldAlert, Loader2, Copy, Check } from "lucide-react";
import { useAuthStore } from "@/store/auth.store";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  useSetupMfaMutation,
  useEnableMfaMutation,
  useDisableMfaMutation,
} from "../hooks";

export function TwoFactorAuthForm() {
  const { user } = useAuthStore();
  const [setupData, setSetupData] = useState<{
    secret: string;
    qrCodeDataUrl: string;
  } | null>(null);
  const [verificationCode, setVerificationCode] = useState("");
  const [disableCode, setDisableCode] = useState("");
  const [copied, setCopied] = useState(false);

  const setupMutation = useSetupMfaMutation();
  const enableMutation = useEnableMfaMutation(() => {
    setSetupData(null);
    setVerificationCode("");
  });
  const disableMutation = useDisableMfaMutation();

  const handleStartSetup = async () => {
    try {
      const data = await setupMutation.mutateAsync();
      setSetupData(data);
    } catch {
      // Handled in mutation onError
    }
  };

  const handleVerifyAndEnable = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(verificationCode)) {
      return;
    }
    enableMutation.mutate(verificationCode);
  };

  const handleCancelSetup = () => {
    setSetupData(null);
    setVerificationCode("");
  };

  const handleCopySecret = () => {
    if (!setupData) return;
    navigator.clipboard.writeText(setupData.secret);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const isEnabled = user?.mfa_enabled;

  return (
    <Card className="overflow-hidden">
      <CardHeader className="bg-muted/40 pb-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div
              className={`p-2 rounded-lg ${isEnabled ? "bg-emerald-500/10 text-emerald-500" : "bg-primary/10 text-primary"}`}
            >
              {isEnabled ? (
                <ShieldCheck className="h-5 w-5" />
              ) : (
                <ShieldAlert className="h-5 w-5" />
              )}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <CardTitle className="text-lg">
                  Two-Factor Authentication (2FA)
                </CardTitle>
                <Badge variant={isEnabled ? "success" : "secondary"}>
                  {isEnabled ? "Enabled" : "Disabled"}
                </Badge>
              </div>
              <CardDescription>
                Secure your operator account with a 6-digit verification code.
              </CardDescription>
            </div>
          </div>
        </div>
      </CardHeader>

      <CardContent className="pt-6">
        {isEnabled ? (
          <div className="space-y-4">
            <div className="p-4 bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-900/40 rounded-xl">
              <p className="text-sm text-emerald-800 dark:text-emerald-300">
                Your account is currently protected by two-factor
                authentication. You will be prompted for a verification code
                from your authenticator app every time you sign in.
              </p>
            </div>
            <form
              className="space-y-3 max-w-sm"
              onSubmit={(event) => {
                event.preventDefault();
                disableMutation.mutate(disableCode, {
                  onSuccess: () => setDisableCode(""),
                });
              }}
            >
              <div className="space-y-1.5">
                <Label htmlFor="mfa-disable-code">
                  Enter your current authenticator code to disable 2FA
                </Label>
                <Input
                  id="mfa-disable-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]*"
                  maxLength={6}
                  placeholder="000000"
                  value={disableCode}
                  onChange={(event) =>
                    setDisableCode(event.target.value.replace(/\D/g, ""))
                  }
                  className="bg-muted/20 text-center text-lg tracking-widest font-mono"
                />
              </div>
              <Button
                type="submit"
                variant="destructive"
                disabled={disableCode.length !== 6 || disableMutation.isPending}
              >
                {disableMutation.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Disabling…
                  </>
                ) : (
                  "Disable 2FA"
                )}
              </Button>
            </form>
          </div>
        ) : setupData ? (
          <div className="space-y-6">
            <div className="grid md:grid-cols-[auto_1fr] gap-6 items-start">
              <div className="border p-3 rounded-xl bg-white flex justify-center w-fit mx-auto md:mx-0">
                <img
                  src={setupData.qrCodeDataUrl}
                  alt="MFA QR Code"
                  className="w-40 h-40 object-contain"
                />
              </div>
              <div className="space-y-4">
                <div className="space-y-1">
                  <h3 className="text-sm font-semibold">1. Scan the QR Code</h3>
                  <p className="text-xs text-muted-foreground">
                    Scan the QR code using Google Authenticator, Authy, or
                    another TOTP application.
                  </p>
                </div>

                <div className="space-y-1">
                  <h3 className="text-sm font-semibold">
                    2. Or enter the secret manually
                  </h3>
                  <div className="flex items-center gap-2 max-w-sm mt-1.5">
                    <code className="flex-1 bg-muted px-3 py-1.5 rounded-lg text-xs font-mono select-all truncate border">
                      {setupData.secret}
                    </code>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={handleCopySecret}
                    >
                      {copied ? (
                        <Check className="h-3.5 w-3.5 text-emerald-500" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </div>
                </div>
              </div>
            </div>

            <hr className="border-muted" />

            <form
              onSubmit={handleVerifyAndEnable}
              className="space-y-4 max-w-sm"
            >
              <div className="space-y-1.5">
                <Label htmlFor="mfa-verify">3. Enter verification code</Label>
                <div className="flex gap-2">
                  <Input
                    id="mfa-verify"
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={6}
                    placeholder="000000"
                    value={verificationCode}
                    onChange={(e) =>
                      setVerificationCode(e.target.value.replace(/\D/g, ""))
                    }
                    className="bg-muted/20 text-center text-lg tracking-widest font-mono"
                    autoFocus
                  />
                  <Button
                    type="submit"
                    disabled={
                      verificationCode.length !== 6 || enableMutation.isPending
                    }
                  >
                    {enableMutation.isPending ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Verifying…
                      </>
                    ) : (
                      "Enable"
                    )}
                  </Button>
                </div>
              </div>

              <div className="flex gap-2 pt-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleCancelSetup}
                  disabled={enableMutation.isPending}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Add an additional layer of security to your operator account by
              enabling two-factor authentication. Once enabled, you will need to
              enter a 6-digit TOTP code in addition to your username and
              password when logging in.
            </p>
            <Button
              onClick={handleStartSetup}
              disabled={setupMutation.isPending}
            >
              {setupMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Generating Setup…
                </>
              ) : (
                "Set up 2FA"
              )}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
